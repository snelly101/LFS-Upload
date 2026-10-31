import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Harness } from './harness.js';

const h = new Harness();
let cookie = '';
beforeAll(async () => {
  await h.start();
  cookie = await h.login(await h.createUser('sender'));
});
afterAll(() => h.stop());

async function uploadWithScan(mode: Parameters<typeof Object.assign>[0]) {
  h.fakeScanner.mode = mode as never;
  const t = await h.api('POST', '/api/transfers', { title: `scan ${(mode as { status: string }).status}` }, cookie);
  const up = await h.tusUpload(cookie, t.json.id, 'doc.pdf', Buffer.from('%PDF-1.4 test'));
  await h.worker.drain(['scan_file']);
  await h.api('PUT', `/api/transfers/${t.json.id}/recipients`, { emails: ['s@example.invalid'] }, cookie);
  const detail = await h.api('GET', `/api/transfers/${t.json.id}`, undefined, cookie);
  const file = (await h.db.query<{ scan_status: string; storage_state: string }>(`SELECT scan_status::text, storage_state::text FROM transfer_files WHERE id = $1`, [up.fileId])).rows[0]!;
  const send = await h.api('POST', `/api/transfers/${t.json.id}/send`, {}, cookie);
  return { id: t.json.id as string, fileId: up.fileId, detail: detail.json, file, send };
}

describe('11. failed/unavailable/oversized/skipped malware scans cannot release files', () => {
  it('clean files are released and the transfer can be sent', async () => {
    const r = await uploadWithScan({ status: 'clean', engine: 'fake' });
    expect(r.file).toEqual({ scan_status: 'clean', storage_state: 'released' });
    expect(r.send.status).toBe(200);
    expect(await h.ctx.storage.exists(h.ctx.storage.pathFor('released', r.fileId))).toBe(true);
    expect(await h.ctx.storage.exists(h.ctx.storage.pathFor('quarantine', r.fileId))).toBe(false);
  });

  for (const mode of [
    { status: 'infected', detail: 'Eicar-Test-Signature', engine: 'fake' },
    { status: 'oversized', detail: 'too big' },
    { status: 'timeout', detail: 'exceeded' },
    { status: 'error', detail: 'scanner said no' },
    { status: 'unavailable', detail: 'ECONNREFUSED' },
  ] as const) {
    it(`${mode.status}: file stays quarantined, send is blocked with an honest reason`, async () => {
      const r = await uploadWithScan(mode);
      expect(r.file.storage_state).toBe('quarantine');
      expect(r.file.scan_status).toBe(mode.status === 'error' || mode.status === 'unavailable' ? 'pending' : mode.status); // retried later
      expect(r.detail.canSend).toBe(false);
      expect(r.detail.blockingReasons.join(' ')).toMatch(mode.status === 'infected' ? /blocked by malware scan/ : mode.status === 'oversized' ? /too large for the malware scanner/ : /scan/);
      expect(r.send.status).toBe(409);
      expect(await h.ctx.storage.exists(h.ctx.storage.pathFor('released', r.fileId))).toBe(false);
      expect(await h.ctx.storage.exists(h.ctx.storage.pathFor('quarantine', r.fileId))).toBe(true);
      const types = (await h.audits(r.id)).map((a) => a.event_type);
      expect(types).toContain(mode.status === 'infected' ? 'scan.blocked' : 'scan.failed');
      expect(types).not.toContain('scan.passed');
      expect((await h.db.query(`SELECT 1 FROM in_app_notifications WHERE transfer_id = $1 AND kind = 'scan'`, [r.id])).rowCount).toBe(1);
      if (mode.status === 'unavailable' || mode.status === 'error') {
        expect((await h.db.query(`SELECT 1 FROM operational_alerts WHERE kind = 'scanner' AND resolved_at IS NULL`)).rowCount).toBeGreaterThan(0);
        const job = (await h.db.query<{ state: string; attempts: number }>(`SELECT state::text, attempts FROM jobs WHERE kind = 'scan_file' AND payload->>'fileId' = $1`, [r.fileId])).rows[0]!;
        expect(job.state).toBe('queued'); // retry scheduled; file remains blocked meanwhile
      }
    });
  }

  it('a file that is too large for the scanner is released only when policy explicitly allows unscanned release, and it is labelled', async () => {
    const admin = await h.createUser('admin');
    const ac = await h.login(admin);
    const settings = await h.api('GET', '/api/admin/settings', undefined, ac);
    const tp = { ...settings.json.settings.transferPolicy, allowUnscannedOversizedRelease: true };
    expect((await h.api('PUT', '/api/admin/settings/transferPolicy', { value: tp, reason: 'accept unscanned oversized files' }, ac)).status).toBe(200);
    const r = await uploadWithScan({ status: 'oversized', detail: 'file is 5e12 bytes; scanner limit is 4e9 bytes' });
    expect(r.file).toEqual({ scan_status: 'oversized', storage_state: 'released' });
    expect(r.send.status).toBe(200);
    const types = (await h.audits(r.id)).map((a) => a.event_type);
    expect(types).toContain('scan.released_unscanned');
    expect(r.detail.files[0].scanStatus).toBe('oversized');
    // the scanner outcome recorded on the file is never 'clean'
    expect(r.detail.files[0].scanDetail).toMatch(/scanner limit/);
  });

  it('a scanner that later recovers releases the retried file', async () => {
    cookie = await h.login({ ...(await h.createUser('sender')), mfa: true });
    const r = await uploadWithScan({ status: 'unavailable', detail: 'down' });
    h.fakeScanner.mode = { status: 'clean', engine: 'fake' };
    await h.runQueuedJobsNow();
    await h.worker.drain(['scan_file']);
    const file = (await h.db.query<{ scan_status: string; storage_state: string }>(`SELECT scan_status::text, storage_state::text FROM transfer_files WHERE id = $1`, [r.fileId])).rows[0]!;
    expect(file).toEqual({ scan_status: 'clean', storage_state: 'released' });
    expect((await h.api('GET', `/api/transfers/${r.id}`, undefined, cookie)).json.status).toBe('ready');
  });
});

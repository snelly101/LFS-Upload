import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Harness } from './harness.js';
import { ClamdScanner } from '../lib/scanner.js';

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const h = new Harness();
let cookie = '';
let clamdUp = false;
beforeAll(async () => {
  await h.start({ scanner: 'real' });
  cookie = await h.login(await h.createUser('sender'));
  clamdUp = (await h.ctx.scanner.ping()).ok;
});
afterAll(() => h.stop());

describe('11b. real clamd over INSTREAM', () => {
  it('reports its version', async () => {
    const p = await h.ctx.scanner.ping();
    expect(p.ok, `clamd must be running on 127.0.0.1:3310 for this test: ${p.error ?? ''}`).toBe(true);
    expect(p.version).toMatch(/ClamAV/);
  });

  it('the EICAR test file is detected and blocked; a clean file is released', async () => {
    if (!clamdUp) return;
    const t = await h.api('POST', '/api/transfers', { title: 'real scan' }, cookie);
    const bad = await h.tusUpload(cookie, t.json.id, 'eicar.com.txt', Buffer.from(EICAR));
    const good = await h.tusUpload(cookie, t.json.id, 'report.txt', Buffer.alloc(2 * 1024 * 1024, 0x41));
    await h.worker.drain(['scan_file']);
    const rows = (await h.db.query<{ id: string; scan_status: string; storage_state: string; scan_detail: string | null; scan_engine: string | null }>(`SELECT id, scan_status::text, storage_state::text, scan_detail, scan_engine FROM transfer_files WHERE transfer_id = $1`, [t.json.id])).rows;
    const b = rows.find((r) => r.id === bad.fileId)!;
    const g = rows.find((r) => r.id === good.fileId)!;
    expect(b.scan_status).toBe('infected');
    expect(b.storage_state).toBe('quarantine');
    expect(b.scan_detail).toMatch(/Eicar/i);
    expect(b.scan_engine).toBe('clamd');
    expect(g.scan_status).toBe('clean');
    expect(g.storage_state).toBe('released');
    await h.api('PUT', `/api/transfers/${t.json.id}/recipients`, { emails: ['v@example.invalid'] }, cookie);
    const send = await h.api('POST', `/api/transfers/${t.json.id}/send`, {}, cookie);
    expect(send.status).toBe(409);
    expect(send.json.message).toMatch(/blocked by malware scan/);
  });

  it('files above the configured scanner limit are reported as not scanned (oversized), never clean', async () => {
    const s = new ClamdScanner('127.0.0.1', 3310, 5000, 1000);
    const r = await s.scanFile('/dev/null', 5000);
    expect(r.status).toBe('oversized');
  });
});

describe('11c. scanner protocol parsing against a fake clamd', () => {
  const SMALL = path.join(os.tmpdir(), 'snelson-fake-clamd-input.bin');
  beforeAll(async () => fs.writeFile(SMALL, Buffer.alloc(1000, 1)));
  /** Minimal INSTREAM server: reads the whole framed stream (ends with a zero-length chunk) then replies. */
  async function fakeClamd(reply: string) {
    const server = net.createServer((sock) => {
      sock.on('error', () => undefined);
      let tail = Buffer.alloc(0);
      sock.on('data', (d) => {
        tail = Buffer.concat([tail, d]).subarray(-4);
        if (tail.equals(Buffer.from([0, 0, 0, 0]))) sock.end(reply);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
  }
  for (const [reply, expected] of [
    ['stream: OK\0', 'clean'],
    ['stream: Win.Test.EICAR_HDB-1 FOUND\0', 'infected'],
    ['INSTREAM size limit exceeded. ERROR\0', 'oversized'],
    ['stream: Something ERROR\0', 'error'],
    ['', 'error'],
  ] as const) {
    it(`"${reply.replace(/\0/g, '')}" → ${expected}`, async () => {
      const f = await fakeClamd(reply);
      const s = new ClamdScanner('127.0.0.1', f.port, 5000, 10 ** 9);
      const r = await s.scanFile(SMALL, 1000);
      expect(r.status).toBe(expected);
      await f.close();
    });
  }
  it('unreachable daemon → unavailable; slow daemon → timeout', async () => {
    const s = new ClamdScanner('127.0.0.1', 1, 1000, 10 ** 9);
    expect((await s.scanFile(SMALL, 1000)).status).toBe('unavailable');
    const server = net.createServer((sock) => sock.on('error', () => undefined));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    const slow = new ClamdScanner('127.0.0.1', port, 300, 10 ** 9);
    expect((await slow.scanFile(SMALL, 1000)).status).toBe('timeout');
    server.close();
  });
});

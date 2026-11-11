import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Harness } from './harness.js';

const h = new Harness();
let alice = '';
let bob = '';
let admin = '';
beforeAll(async () => {
  await h.start();
  alice = await h.login(await h.createUser('sender'));
  bob = await h.login(await h.createUser('sender'));
  admin = await h.login(await h.createUser('admin'));
});
afterAll(() => h.stop());

/** Create a request and return its id and the raw invitation token per contributor. */
async function makeRequest(cookie: string, emails: string[], title = 'Proof of address') {
  const before = h.mailer.sent.length;
  const r = await h.api('POST', '/api/requests', { title, message: 'A utility bill from the last three months, please.', emails }, cookie);
  if (r.status !== 201) throw new Error(`request failed ${r.status} ${r.text}`);
  await h.worker.drain(['deliver_outbox']);
  const tokens: Record<string, string> = {};
  for (const e of emails) {
    const mail = h.mailer.sent.slice(before).find((m) => m.to === e && /asked you to send files/.test(m.subject));
    if (!mail) throw new Error(`no request mail for ${e}`);
    tokens[e] = mail.text.match(/\/r\/([A-Za-z0-9_-]+)/)![1]!;
  }
  return { id: r.json.id as string, detail: r.json, tokens, mails: h.mailer.sent.slice(before) };
}

/** Contributor registers and uploads one file through the token-scoped tus endpoint. */
async function contribute(token: string, cookie: string, name: string, data: Buffer) {
  const reg = await h.api('POST', `/api/r/${token}/uploads`, { name, sizeBytes: data.length }, cookie);
  if (reg.status !== 201) return { reg };
  const create = await h.raw(`/api/r/${token}/tus`, { method: 'POST', cookie, headers: { 'tus-resumable': '1.0.0', 'upload-length': String(data.length), 'upload-metadata': `uploadId ${Buffer.from(reg.json.uploadId).toString('base64')}` } });
  if (create.status !== 201) throw new Error(`tus create ${create.status} ${await create.text()}`);
  const location = create.headers.get('location')!;
  const patch = await h.raw(location, { method: 'PATCH', cookie, headers: { 'tus-resumable': '1.0.0', 'upload-offset': '0', 'content-type': 'application/offset+octet-stream' }, body: new Uint8Array(data) });
  if (patch.status !== 204) throw new Error(`tus patch ${patch.status} ${await patch.text()}`);
  return { reg, location, fileId: reg.json.file.id as string, uploadId: reg.json.uploadId as string };
}

describe('20. file requests: named, verified contributors send files in; only the requester can read them', () => {
  it('the invitation reveals nothing, the link alone does nothing, and verification is always required', async () => {
    const rq = await makeRequest(alice, ['tenant@example.invalid']);
    const mail = rq.mails.find((m) => m.to === 'tenant@example.invalid')!;
    expect(mail.subject).not.toContain('Proof of address');
    expect(mail.text).not.toContain('Proof of address');
    expect(mail.text).not.toContain('utility bill');
    const token = rq.tokens['tenant@example.invalid']!;
    const pub = await h.api('GET', `/api/r/${token}`);
    expect(pub.json.state).toBe('needs_verification');
    expect(pub.json.purpose).toBe('upload');
    expect(JSON.stringify(pub.json)).not.toMatch(/Proof of address|utility bill|tenant@example/);
    // no session: cannot register, upload, view or use the bearer shortcut
    expect((await h.api('POST', `/api/r/${token}/uploads`, { name: 'a.pdf', sizeBytes: 10 })).status).toBe(401);
    expect((await h.raw(`/api/r/${token}/tus`, { method: 'POST', headers: { 'tus-resumable': '1.0.0', 'upload-length': '10' } })).status).toBe(401);
    expect((await h.api('GET', `/api/r/${token}/view`)).status).toBe(401);
    expect((await h.api('POST', `/api/r/${token}/open`, {})).status).toBe(409);
    // a staff session is not a contributor session
    expect((await h.raw(`/api/r/${token}/tus`, { method: 'POST', cookie: alice, headers: { 'tus-resumable': '1.0.0', 'upload-length': '10' } })).status).toBe(401);
  });

  it('a verified contributor uploads; the file is scanned; only the requester can download it, byte for byte', async () => {
    const rq = await makeRequest(alice, ['c1@example.invalid', 'c2@example.invalid'], 'Signed tenancy agreement');
    const t1 = rq.tokens['c1@example.invalid']!;
    const t2 = rq.tokens['c2@example.invalid']!;
    const v1 = await h.verifyRecipient(t1);
    expect(v1.view.direction).toBe('inbound');
    expect(v1.view.title).toBe('Signed tenancy agreement');
    expect(v1.view.uploads).toEqual([]);
    const data = Buffer.alloc(300_000);
    for (let i = 0; i < data.length; i += 7) data[i] = (i * 31) & 0xff;
    const up = await contribute(t1, v1.cookie, 'agreement ✓.pdf', data);
    expect(up.reg.status).toBe(201);
    // before the scan nobody can download it, including the requester
    expect((await h.raw(`/api/transfers/${rq.id}/files/${up.fileId}/download`, { cookie: alice })).status).toBe(404);
    await h.worker.drain();
    const view = await h.api('GET', `/api/r/${t1}/view`, undefined, v1.cookie);
    expect(view.json.uploads).toHaveLength(1);
    expect(view.json.uploads[0].state).toBe('received');
    // requester: full and ranged download
    const full = await h.raw(`/api/transfers/${rq.id}/files/${up.fileId}/download`, { cookie: alice });
    expect(full.status).toBe(200);
    expect(full.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(full.headers.get('cache-control')).toMatch(/no-store/);
    expect(Buffer.from(await full.arrayBuffer()).equals(data)).toBe(true);
    const part = await h.raw(`/api/transfers/${rq.id}/files/${up.fileId}/download`, { cookie: alice, headers: { range: 'bytes=1000-1999' } });
    expect(part.status).toBe(206);
    expect(Buffer.from(await part.arrayBuffer()).equals(data.subarray(1000, 2000))).toBe(true);
    // not another sender, not an administrator, not anonymous
    expect((await h.raw(`/api/transfers/${rq.id}/files/${up.fileId}/download`, { cookie: bob })).status).toBe(404);
    expect((await h.raw(`/api/transfers/${rq.id}/files/${up.fileId}/download`, { cookie: admin })).status).toBe(404);
    expect((await h.raw(`/api/transfers/${rq.id}/files/${up.fileId}/download`)).status).toBe(401);
    // contributors can never download: not their own file, not via zip
    expect((await h.raw(`/api/r/${t1}/files/${up.fileId}`, { cookie: v1.cookie })).status).toBe(404);
    expect((await h.raw(`/api/r/${t1}/zip`, { cookie: v1.cookie })).status).toBe(404);
    // a second contributor sees none of the first one's uploads and cannot touch them
    const v2 = await h.verifyRecipient(t2);
    expect(v2.view.uploads).toEqual([]);
    expect((await h.raw(`/api/r/${t2}/files/${up.fileId}`, { cookie: v2.cookie })).status).toBe(404);
    expect((await h.raw(`/api/r/${t2}/tus/${up.uploadId}`, { method: 'HEAD', cookie: v2.cookie, headers: { 'tus-resumable': '1.0.0' } })).status).toBe(404);
    // c1's session cookie does not work on c2's link
    expect((await h.api('GET', `/api/r/${t2}/view`, undefined, v1.cookie)).status).toBe(401);
    // the staff upload endpoint cannot be used to reach an inbound upload id
    expect((await h.raw(`/api/uploads/tus/${up.uploadId}`, { method: 'HEAD', cookie: alice, headers: { 'tus-resumable': '1.0.0' } })).status).toBe(404);
    // requester sees who sent what, and was notified; audit trail is complete
    const detail = await h.api('GET', `/api/transfers/${rq.id}`, undefined, alice);
    expect(detail.json.direction).toBe('inbound');
    expect(detail.json.files[0].uploadedByEmail).toBe('c1@example.invalid');
    expect(detail.json.grants.find((g: { email: string }) => g.email === 'c1@example.invalid').filesUploaded).toBe(1);
    const notes = await h.api('GET', '/api/notifications', undefined, alice);
    expect(notes.json.items.some((n: { kind: string }) => n.kind === 'inbound_received')).toBe(true);
    for (const type of ['request.created', 'recipient.verified', 'inbound.file_registered', 'upload.completed', 'scan.passed', 'inbound.downloaded_by_owner']) {
      expect((await h.audits(rq.id, type)).length, type).toBeGreaterThan(0);
    }
    // ordinary outbound transfers have no staff download route
    const out = await h.sendTransfer(alice, { recipients: ['x@example.invalid'] });
    expect((await h.raw(`/api/transfers/${out.id}/files/${out.detail.files[0].id}/download`, { cookie: alice })).status).toBe(404);
  });

  it('limits apply to contributors: size the scanner can check, blocked types, file count', async () => {
    const rq = await makeRequest(alice, ['lim@example.invalid']);
    const token = rq.tokens['lim@example.invalid']!;
    const v = await h.verifyRecipient(token);
    const policy = await h.api('GET', '/api/transfers/policy', undefined, alice);
    const big = await h.api('POST', `/api/r/${token}/uploads`, { name: 'huge.zip', sizeBytes: policy.json.effectiveMaxFileBytes + 1 }, v.cookie);
    expect(big.status).toBe(400);
    expect(big.json.error).toBe('file_too_large');
    expect((await h.api('POST', `/api/r/${token}/uploads`, { name: 'run-me.exe', sizeBytes: 10 }, v.cookie)).json.error).toBe('blocked_type');
    const settings = await h.api('GET', '/api/admin/settings', undefined, admin);
    await h.api('PUT', '/api/admin/settings/transferPolicy', { value: { ...settings.json.settings.transferPolicy, maxFilesPerTransfer: 1 }, reason: 'test' }, admin);
    expect((await contribute(token, v.cookie, 'one.pdf', Buffer.from('one'))).reg.status).toBe(201);
    expect((await h.api('POST', `/api/r/${token}/uploads`, { name: 'two.pdf', sizeBytes: 3 }, v.cookie)).json.error).toBe('too_many_files');
    await h.api('PUT', '/api/admin/settings/transferPolicy', { value: settings.json.settings.transferPolicy, reason: 'restore' }, admin);
    // declared size is enforced by the upload endpoint
    const reg = await h.api('POST', `/api/r/${token}/uploads`, { name: 'short.pdf', sizeBytes: 5 }, v.cookie);
    const wrong = await h.raw(`/api/r/${token}/tus`, { method: 'POST', cookie: v.cookie, headers: { 'tus-resumable': '1.0.0', 'upload-length': '50', 'upload-metadata': `uploadId ${Buffer.from(reg.json.uploadId).toString('base64')}` } });
    expect(wrong.status).toBe(400);
  });

  it('a file that fails the scan is never downloadable and the contributor is told it was blocked', async () => {
    const rq = await makeRequest(alice, ['mal@example.invalid']);
    const token = rq.tokens['mal@example.invalid']!;
    const v = await h.verifyRecipient(token);
    h.fakeScanner.mode = { status: 'infected', detail: 'Eicar-Test-Signature', engine: 'fake' };
    const up = await contribute(token, v.cookie, 'invoice.pdf', Buffer.from('pretend malware'));
    await h.worker.drain();
    h.fakeScanner.mode = { status: 'clean', engine: 'fake' };
    expect((await h.raw(`/api/transfers/${rq.id}/files/${up.fileId}/download`, { cookie: alice })).status).toBe(404);
    expect((await h.api('GET', `/api/r/${token}/view`, undefined, v.cookie)).json.uploads[0].state).toBe('blocked');
    expect((await h.audits(rq.id, 'scan.blocked')).length).toBe(1);
  });

  it('closing stops uploads and kills links but keeps received files; expiry removes access and the bytes', async () => {
    const rq = await makeRequest(alice, ['late@example.invalid']);
    const token = rq.tokens['late@example.invalid']!;
    const v = await h.verifyRecipient(token);
    const up = await contribute(token, v.cookie, 'kept.pdf', Buffer.from('keep me'));
    await h.worker.drain();
    // another sender cannot close it
    expect((await h.api('POST', `/api/transfers/${rq.id}/close`, {}, bob)).status).toBe(404);
    const closed = await h.api('POST', `/api/transfers/${rq.id}/close`, { reason: 'have what I need' }, alice);
    expect(closed.status).toBe(200);
    expect(closed.json.closedAt).toBeTruthy();
    expect((await h.api('GET', `/api/r/${token}`)).json.state).toBe('revoked');
    expect((await h.api('POST', `/api/r/${token}/uploads`, { name: 'more.pdf', sizeBytes: 3 }, v.cookie)).status).toBe(401);
    expect((await h.api('POST', `/api/transfers/${rq.id}/recipients`, { email: 'extra@example.invalid', reason: 'x' }, alice)).status).toBe(409);
    const still = await h.raw(`/api/transfers/${rq.id}/files/${up.fileId}/download`, { cookie: alice });
    expect(still.status).toBe(200);
    expect(await still.text()).toBe('keep me');
    // past the deadline the owner's access ends even with no worker, then deletion removes the bytes
    h.clock.advance(31 * 24 * 3_600_000);
    const ownerRow = (await h.db.query<{ email: string }>(`SELECT u.email::text FROM transfers t JOIN users u ON u.id = t.sender_id WHERE t.id = $1`, [rq.id])).rows[0]!;
    const ownerAgain = await h.login({ email: ownerRow.email, mfa: true } as never);
    const expired = await h.raw(`/api/transfers/${rq.id}/files/${up.fileId}/download`, { cookie: ownerAgain });
    expect(expired.status).toBe(410);
    await h.runQueuedJobsNow();
    await h.worker.drain();
    const row = (await h.db.query<{ deletion_status: string; status: string }>(`SELECT deletion_status::text, status::text FROM transfers WHERE id = $1`, [rq.id])).rows[0]!;
    expect(row.deletion_status).toBe('deleted');
    expect((await h.db.query<{ storage_state: string }>(`SELECT storage_state::text FROM transfer_files WHERE id = $1`, [up.fileId])).rows[0]!.storage_state).toBe('deleted');
  });

  it('lists filter by direction and show received counts; a contributor can withdraw an unfinished upload; the owner gets live events', async () => {
    const owner = await h.login(await h.createUser('sender'));
    const rq = await makeRequest(owner, ['w1@example.invalid', 'w2@example.invalid'], 'Photos of the repair');
    await h.sendTransfer(owner, { title: 'Outbound one', recipients: ['o@example.invalid'] });
    const token = rq.tokens['w1@example.invalid']!;
    const v = await h.verifyRecipient(token);
    // live events: open the owner's stream, then let a contributor upload
    const ac = new AbortController();
    const res = await h.raw('/api/events', { cookie: owner, signal: ac.signal });
    const reader = res.body!.getReader();
    let buf = '';
    const dec = new TextDecoder();
    const pump = (async () => {
      try {
        let step = await reader.read();
        while (!step.done) {
          buf += dec.decode(step.value, { stream: true });
          step = await reader.read();
        }
      } catch {
        /* aborted */
      }
    })();
    await new Promise((r) => setTimeout(r, 150));
    await contribute(token, v.cookie, 'before.jpg', Buffer.from('jpeg-ish'));
    await h.worker.drain();
    for (let i = 0; i < 40 && !buf.includes(rq.id); i++) await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    await pump;
    expect(buf).toContain(rq.id);
    // a registered-but-unfinished upload can be withdrawn by its contributor only
    const pending = await h.api('POST', `/api/r/${token}/uploads`, { name: 'never-sent.jpg', sizeBytes: 100 }, v.cookie);
    expect(pending.status).toBe(201);
    const t2 = rq.tokens['w2@example.invalid']!;
    const v2 = await h.verifyRecipient(t2);
    expect((await h.api('POST', `/api/r/${t2}/uploads/${pending.json.file.id}/withdraw`, {}, v2.cookie)).status).toBe(404);
    expect((await h.api('POST', `/api/r/${token}/uploads/${pending.json.file.id}/withdraw`, {}, v.cookie)).status).toBe(200);
    const view = await h.api('GET', `/api/r/${token}/view`, undefined, v.cookie);
    expect(view.json.uploads.map((u: { name: string }) => u.name)).toEqual(['before.jpg']);
    // a finished file cannot be withdrawn by the contributor
    expect((await h.api('POST', `/api/r/${token}/uploads/${view.json.uploads[0].id}/withdraw`, {}, v.cookie)).status).toBe(409);
    // list filter and counts
    const inbound = await h.api('GET', '/api/transfers?direction=inbound', undefined, owner);
    expect(inbound.json.total).toBe(1);
    expect(inbound.json.items[0].direction).toBe('inbound');
    expect(inbound.json.items[0].filesReceived).toBe(1);
    expect(inbound.json.items[0].closedAt).toBeNull();
    expect((await h.api('GET', '/api/transfers?direction=outbound', undefined, owner)).json.total).toBe(1);
    expect((await h.api('GET', '/api/transfers', undefined, owner)).json.total).toBe(2);
    await h.api('POST', `/api/transfers/${rq.id}/close`, {}, owner);
    expect((await h.api('GET', '/api/transfers?direction=inbound', undefined, owner)).json.items[0].closedAt).toBeTruthy();
  });

  it('an administrator can turn file requests off', async () => {
    const adminNow = await h.login(await h.createUser('admin'));
    const senderNow = await h.login(await h.createUser('sender'));
    const settings = await h.api('GET', '/api/admin/settings', undefined, adminNow);
    await h.api('PUT', '/api/admin/settings/transferPolicy', { value: { ...settings.json.settings.transferPolicy, allowFileRequests: false }, reason: 'policy' }, adminNow);
    const r = await h.api('POST', '/api/requests', { title: 'x', emails: ['a@example.invalid'] }, senderNow);
    expect(r.status).toBe(403);
  });
});

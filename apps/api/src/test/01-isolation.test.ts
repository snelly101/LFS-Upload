import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Harness } from './harness.js';

const h = new Harness();
let aCookie = '';
let bCookie = '';
let aTransfer = '';
let aUpload: { fileId: string; uploadId: string; location: string };

beforeAll(async () => {
  await h.start();
  const a = await h.createUser('sender');
  const b = await h.createUser('sender');
  aCookie = await h.login(a);
  bCookie = await h.login(b);
  const t = await h.api('POST', '/api/transfers', { title: 'A private' }, aCookie);
  aTransfer = t.json.id;
  // register + partially upload so the upload id is live
  const reg = await h.api('POST', `/api/transfers/${aTransfer}/files`, { name: 'a.bin', sizeBytes: 2 * 1024 * 1024 }, aCookie);
  const location = await h.tusCreate(aCookie, reg.json.uploadId, 2 * 1024 * 1024);
  await h.tusPatch(aCookie, location, Buffer.alloc(2 * 1024 * 1024, 1), 0, { stopAfterBytes: 1024 * 1024 });
  aUpload = { fileId: reg.json.file.id, uploadId: reg.json.uploadId, location };
});
afterAll(() => h.stop());

describe('1. a sender cannot read, modify, enumerate or resume another sender’s transfers/upload sessions', () => {
  it('list only shows own transfers', async () => {
    const r = await h.api('GET', '/api/transfers', undefined, bCookie);
    expect(r.status).toBe(200);
    expect(r.json.items).toHaveLength(0);
    const ra = await h.api('GET', '/api/transfers', undefined, aCookie);
    expect(ra.json.items.map((t: { id: string }) => t.id)).toContain(aTransfer);
  });

  it('get / patch / activity / send / revoke / files / recipients on another sender’s transfer are 404', async () => {
    for (const [m, p, body] of [
      ['GET', `/api/transfers/${aTransfer}`, undefined],
      ['PATCH', `/api/transfers/${aTransfer}`, { title: 'hijack' }],
      ['GET', `/api/transfers/${aTransfer}/activity`, undefined],
      ['POST', `/api/transfers/${aTransfer}/send`, {}],
      ['POST', `/api/transfers/${aTransfer}/revoke`, {}],
      ['POST', `/api/transfers/${aTransfer}/files`, { name: 'x', sizeBytes: 1 }],
      ['DELETE', `/api/transfers/${aTransfer}/files/${aUpload.fileId}`, undefined],
      ['PUT', `/api/transfers/${aTransfer}/recipients`, { emails: ['x@example.invalid'] }],
      ['POST', `/api/transfers/${aTransfer}/extend`, { expiresAt: new Date(Date.now() + 3600e3).toISOString(), reason: 'x' }],
    ] as const) {
      const r = await h.api(m, p, body as never, bCookie);
      expect(r.status, `${m} ${p}`).toBe(404);
    }
    // title untouched
    const own = await h.api('GET', `/api/transfers/${aTransfer}`, undefined, aCookie);
    expect(own.json.title).toBe('A private');
  });

  it('tus HEAD / PATCH / DELETE on another sender’s upload id are 404 (generic, no distinction from unknown ids)', async () => {
    const head = await h.raw(aUpload.location, { method: 'HEAD', cookie: bCookie, headers: { 'tus-resumable': '1.0.0' } });
    expect(head.status).toBe(404);
    const patch = await h.raw(aUpload.location, { method: 'PATCH', cookie: bCookie, headers: { 'tus-resumable': '1.0.0', 'upload-offset': '1048576', 'content-type': 'application/offset+octet-stream' }, body: Buffer.alloc(1024, 9) });
    expect(patch.status).toBe(404);
    const del = await h.raw(aUpload.location, { method: 'DELETE', cookie: bCookie, headers: { 'tus-resumable': '1.0.0' } });
    expect(del.status).toBe(404);
    // creating an upload against another sender's registered upload id is also rejected
    const create = await h.raw('/api/uploads/tus', { method: 'POST', cookie: bCookie, headers: { 'tus-resumable': '1.0.0', 'upload-length': '2097152', 'upload-metadata': `uploadId ${Buffer.from(aUpload.uploadId).toString('base64')}` } });
    expect(create.status).toBe(404);
    // owner still sees the correct offset and the bytes are intact
    const mine = await h.tusHead(aCookie, aUpload.location);
    expect(mine.status).toBe(200);
    expect(mine.offset).toBe(1024 * 1024);
    const unknown = await h.raw(`/api/uploads/tus/${randomUUID().replace(/-/g, '')}`, { method: 'HEAD', cookie: bCookie, headers: { 'tus-resumable': '1.0.0' } });
    expect(unknown.status).toBe(404);
  });

  it('random ids cannot be enumerated and unauthenticated access is 401', async () => {
    expect((await h.api('GET', `/api/transfers/${randomUUID()}`, undefined, bCookie)).status).toBe(404);
    expect((await h.api('GET', `/api/transfers/${aTransfer}`)).status).toBe(401);
    const anon = await h.raw(aUpload.location, { method: 'HEAD', headers: { 'tus-resumable': '1.0.0' } });
    expect(anon.status).toBe(401);
  });

  it('an auditor cannot create transfers or touch uploads', async () => {
    const aud = await h.createUser('auditor');
    const c = await h.login(aud);
    expect((await h.api('POST', '/api/transfers', { title: 'nope' }, c)).status).toBe(403);
    const head = await h.raw(aUpload.location, { method: 'HEAD', cookie: c, headers: { 'tus-resumable': '1.0.0' } });
    expect(head.status).toBe(403);
  });
});

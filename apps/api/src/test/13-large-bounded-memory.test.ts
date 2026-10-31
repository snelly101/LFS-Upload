import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Harness, prngSource } from './harness.js';

const h = new Harness();
let cookie = '';
const LARGE = process.env.LARGE_TESTS === '1';
const SIZE = Number(process.env.LARGE_SIZE_BYTES ?? 1024 ** 3);
const CHUNK = Number(process.env.LARGE_CHUNK_BYTES ?? 16 * 1024 * 1024);

beforeAll(async () => {
  await h.start();
  cookie = await h.login(await h.createUser('sender'));
});
afterAll(() => h.stop());

describe.skipIf(!LARGE)('13. large-file upload/download with bounded memory (LARGE_TESTS=1)', () => {
  it(`uploads and downloads ${SIZE / 1024 ** 3} GiB through the API with bounded process memory`, async () => {
    const src = prngSource(SIZE, 11);
    const rssSamples: number[] = [];
    const baseline = process.memoryUsage().rss;
    const sampler = setInterval(() => rssSamples.push(process.memoryUsage().rss), 250);
    const t0 = Date.now();
    const t = await h.api('POST', '/api/transfers', { title: 'large' }, cookie);
    const up = await h.tusUpload(cookie, t.json.id, 'large.bin', src, { chunkSize: CHUNK });
    const tUpload = Date.now() - t0;
    expect(up.offset).toBe(SIZE);
    const t1 = Date.now();
    await h.worker.drain(['scan_file']); // FakeScanner: clean (clamd has a 100 MiB limit in this environment)
    const tScan = Date.now() - t1;
    await h.api('PUT', `/api/transfers/${t.json.id}/recipients`, { emails: ['large@example.invalid'] }, cookie);
    const sent = await h.api('POST', `/api/transfers/${t.json.id}/send`, {}, cookie);
    expect(sent.status).toBe(200);
    await h.worker.drain(['deliver_outbox']);
    const token = h.findMail((m) => m.to === 'large@example.invalid')!.text.match(/\/r\/([A-Za-z0-9_-]+)/)![1]!;
    const v = await h.verifyRecipient(token);
    const t2 = Date.now();
    const res = await h.raw(`/api/r/${token}/files/${up.fileId}`, { cookie: v.cookie });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    let received = 0;
    let pending = Buffer.alloc(0);
    let verified = true;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending = pending.length ? Buffer.concat([pending, Buffer.from(value!)]) : Buffer.from(value!);
      // verify in 4 MiB aligned blocks
      const block = 4 * 1024 * 1024;
      while (pending.length >= block) {
        if (!pending.subarray(0, block).equals(src.chunk(received, block))) verified = false;
        received += block;
        pending = pending.subarray(block);
      }
    }
    if (pending.length) {
      if (!pending.equals(src.chunk(received, pending.length))) verified = false;
      received += pending.length;
    }
    const tDownload = Date.now() - t2;
    clearInterval(sampler);
    expect(received).toBe(SIZE);
    expect(verified).toBe(true);
    const peak = Math.max(...rssSamples);
    const growth = peak - baseline;
    console.log(`[evidence] size=${SIZE} chunk=${CHUNK} upload=${tUpload}ms scan=${tScan}ms download=${tDownload}ms rssBaseline=${(baseline / 1048576).toFixed(0)}MiB rssPeak=${(peak / 1048576).toFixed(0)}MiB growth=${(growth / 1048576).toFixed(0)}MiB`);
    expect(growth).toBeLessThan(300 * 1024 * 1024); // note: the in-process test client (chunk buffers, verification) is included in this figure
    await h.api('POST', `/api/transfers/${t.json.id}/delete-now`, {}, cookie);
    await h.worker.drain();
    expect(await h.ctx.storage.exists(h.ctx.storage.pathFor('released', up.fileId))).toBe(false);
  });
});

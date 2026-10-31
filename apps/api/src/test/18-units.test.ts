import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mergeRanges, parseRange } from '../services/downloads.js';
import { contentDisposition, dedupeFilename, sanitiseFilename } from '../lib/filenames.js';
import { csvCell } from '../routes/audit.js';
import { audit, redactDetails, verifyChain } from '../lib/audit.js';
import { HttpError } from '../context.js';
import { Harness } from './harness.js';
import { ipPrefix } from '../lib/crypto.js';

describe('parseRange / mergeRanges', () => {
  it('parses single ranges and suffix ranges, clamps the end', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=0-1000', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=0-9,20-29', 100)).toBeNull(); // multi-range ignored → full body
    expect(parseRange('items=0-9', 100)).toBeNull();
  });
  it('rejects unsatisfiable ranges with 416', () => {
    for (const r of ['bytes=100-', 'bytes=200-300', 'bytes=50-40', 'bytes=-0']) {
      expect(() => parseRange(r, 100)).toThrow(HttpError);
      try {
        parseRange(r, 100);
      } catch (e) {
        expect((e as HttpError).statusCode).toBe(416);
      }
    }
  });
  it('merges overlapping and adjacent half-open intervals without double counting', () => {
    expect(mergeRanges([[0, 100], [50, 150]])).toEqual({ merged: [[0, 150]], covered: 150 });
    expect(mergeRanges([[0, 100], [100, 200]])).toEqual({ merged: [[0, 200]], covered: 200 });
    expect(mergeRanges([[200, 300], [0, 100]])).toEqual({ merged: [[0, 100], [200, 300]], covered: 200 });
    expect(mergeRanges([[0, 0], [5, 5]])).toEqual({ merged: [], covered: 0 });
    expect(mergeRanges([[0, 10], [2, 3], [9, 12], [20, 25], [24, 26]])).toEqual({ merged: [[0, 12], [20, 26]], covered: 18 });
  });
});

describe('filenames', () => {
  it('strips paths, control characters and reserved names while keeping Unicode', () => {
    expect(sanitiseFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitiseFilename('C:\\Users\\x\\report.docx')).toBe('report.docx');
    expect(sanitiseFilename('..')).toBe('file');
    expect(sanitiseFilename('.hidden')).toBe('hidden');
    expect(sanitiseFilename('na\u0000me\u001f.txt')).toBe('name.txt');
    expect(sanitiseFilename('Résumé – 2026 ✓.pdf')).toBe('Résumé – 2026 ✓.pdf');
    expect(sanitiseFilename('a<b>c:d"e|f?g*h.txt')).toBe('a_b_c_d_e_f_g_h.txt');
    expect(sanitiseFilename('x'.repeat(500) + '.tar.gz').length).toBeLessThanOrEqual(180);
    expect(sanitiseFilename('')).toBe('file');
  });
  it('de-duplicates case-insensitively', () => {
    const existing = new Set(['report.pdf', 'report (2).pdf']);
    expect(dedupeFilename('Report.pdf', existing)).toBe('Report (3).pdf');
    expect(dedupeFilename('other.pdf', existing)).toBe('other.pdf');
  });
  it('builds RFC 6266 dispositions with an ASCII fallback', () => {
    const d = contentDisposition('Résumé ✓.pdf');
    expect(d).toBe(`attachment; filename="R_sum_ _.pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%E2%9C%93.pdf`);
    expect(contentDisposition('a"b\\c.txt')).toContain('filename="a_b_c.txt"');
  });
});

describe('csvCell', () => {
  it('neutralises formula triggers and quotes separators', () => {
    expect(csvCell('=SUM(A1)')).toBe(`'=SUM(A1)`);
    expect(csvCell('+1')).toBe(`'+1`);
    expect(csvCell('-1')).toBe(`'-1`);
    expect(csvCell('@cmd')).toBe(`'@cmd`);
    expect(csvCell('\tx')).toBe(`'\tx`);
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe('');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });
});

describe('redactDetails / ipPrefix', () => {
  it('redacts secret-looking keys recursively and truncates long strings', () => {
    const r = redactDetails({ token: 'abc', nested: { password: 'x', ok: 'y' }, long: 'z'.repeat(3000), code: '123456' });
    expect(r.token).toBe('[redacted]');
    expect((r.nested as Record<string, unknown>).password).toBe('[redacted]');
    expect((r.nested as Record<string, unknown>).ok).toBe('y');
    expect((r.long as string).length).toBeLessThan(2010);
    expect(r.code).toBe('[redacted]');
  });
  it('reduces IPs to prefixes', () => {
    expect(ipPrefix('192.168.12.34')).toBe('192.168.12.0/24');
    expect(ipPrefix('::ffff:10.1.2.3')).toBe('10.1.2.0/24');
    expect(ipPrefix('2001:db8:abcd:1234::1')).toBe('2001:db8:abcd::/48');
    expect(ipPrefix(undefined)).toBeNull();
  });
});

describe('audit chain integrity', () => {
  const h = new Harness();
  beforeAll(() => h.start());
  afterAll(() => h.stop());
  it('verifies a clean chain, detects tampering, and survives concurrent appends', async () => {
    await Promise.all(Array.from({ length: 25 }, (_, i) => h.db.tx((c) => audit(c, { actorKind: 'system', eventType: 'test.event', details: { i } }))));
    const ok = await verifyChain(h.db);
    expect(ok).toEqual({ ok: true, checked: 25 });
    // tamper via the purge function path is impossible (DELETE only). Simulate an operator with trigger rights.
    await h.db.query(`ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update`);
    await h.db.query(`UPDATE audit_events SET details = '{"i":999}' WHERE id = 10`);
    await h.db.query(`ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update`);
    const bad = await verifyChain(h.db);
    expect(bad.ok).toBe(false);
    expect(bad.brokenAt).toBe(10);
  });
});

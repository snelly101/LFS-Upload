import path from 'node:path';

/**
 * Produce a safe display/download filename from untrusted input. Keeps Unicode letters, strips
 * path separators, control characters and leading dots, and bounds length.
 */
export function sanitiseFilename(input: string, fallback = 'file'): string {
  let name = input.normalize('NFC');
  name = path.posix.basename(name.replace(/\\/g, '/'));
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, '');
  name = name.replace(/[<>:"|?*]/g, '_');
  name = name.replace(/^\.+/, '').trim();
  if (name === '' || name === '.' || name === '..') name = fallback;
  if (name.length > 180) {
    const ext = path.posix.extname(name).slice(0, 20);
    name = name.slice(0, 180 - ext.length) + ext;
  }
  return name;
}

/** Ensure uniqueness within a transfer by appending (n) before the extension. */
export function dedupeFilename(name: string, existing: Set<string>): string {
  if (!existing.has(name.toLowerCase())) return name;
  const ext = path.posix.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!existing.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

/** RFC 6266 attachment disposition with ASCII fallback and UTF-8 filename*. */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

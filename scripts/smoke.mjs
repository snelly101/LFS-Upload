// End-to-end smoke test of the vertical slice against a running dev API (+ worker drained inline).
import * as OTPAuth from '/home/user/LFS-Upload/apps/api/node_modules/otpauth/dist/otpauth.node.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://localhost:3000';
const H = { 'content-type': 'application/json', 'x-requested-with': 'snelson' };
let cookie = '';
async function api(method, url, body, extra = {}) {
  const r = await fetch(BASE + url, { method, headers: { ...H, cookie, ...extra.headers }, body: body === undefined ? undefined : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body), redirect: 'manual' });
  const sc = r.headers.getSetCookie?.() ?? [];
  for (const c of sc) {
    const [kv] = c.split(';');
    const [k] = kv.split('=');
    cookie = cookie.split('; ').filter((x) => x && !x.startsWith(k + '=')).concat(kv).join('; ');
  }
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!r.ok && !extra.allowFail) throw new Error(`${method} ${url} -> ${r.status} ${text.slice(0, 300)}`);
  return { status: r.status, json, headers: r.headers };
}
const secret = process.argv[2];
const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) });

console.log('login'); console.log((await api('POST', '/api/auth/login', { email: 'admin@dev.snelson.invalid', password: 'correct-horse-battery-staple-2026' })).json);
const me = (await api('GET', '/api/auth/me')).json;
if (!me.mfa.enrolled) { console.log('confirm totp', (await api('POST', '/api/auth/enrol/totp/confirm', { code: totp.generate() })).json); }
else {
  // TOTP codes are one-time per 30 s step; if this step was already used, wait for the next one.
  let r = await api('POST', '/api/auth/mfa/totp/verify', { code: totp.generate() }, { allowFail: true });
  if (r.status !== 200) { await new Promise((res) => setTimeout(res, 30_000 - (Date.now() % 30_000) + 500)); r = await api('POST', '/api/auth/mfa/totp/verify', { code: totp.generate() }); }
  console.log('mfa', r.json);
}
console.log('me', (await api('GET', '/api/auth/me')).json.user.authLevel);

const t = (await api('POST', '/api/transfers', { title: 'Smoke test', message: 'hello', notifyPrefs: { everyDownload: true } })).json;
console.log('transfer', t.id, t.status);
const data = Buffer.alloc(3 * 1024 * 1024 + 123, 7);
const f = (await api('POST', `/api/transfers/${t.id}/files`, { name: 'blob ✓.bin', sizeBytes: data.length })).json;
console.log('file', f.file.displayName, f.uploadId);
// tus create
const meta = `uploadId ${Buffer.from(f.uploadId).toString('base64')}`;
const cr = await fetch(BASE + '/api/uploads/tus', { method: 'POST', headers: { cookie, 'tus-resumable': '1.0.0', 'upload-length': String(data.length), 'upload-metadata': meta } });
console.log('tus create', cr.status, cr.headers.get('location'));
const loc = cr.headers.get('location');
let offset = 0; const CH = 1024 * 1024;
while (offset < data.length) {
  const chunk = data.subarray(offset, Math.min(offset + CH, data.length));
  const pr = await fetch(BASE + loc, { method: 'PATCH', headers: { cookie, 'tus-resumable': '1.0.0', 'upload-offset': String(offset), 'content-type': 'application/offset+octet-stream' }, body: chunk });
  if (pr.status !== 204) throw new Error('patch ' + pr.status + ' ' + (await pr.text()));
  offset = Number(pr.headers.get('upload-offset'));
}
console.log('uploaded', offset);
console.log('detail', (await api('GET', `/api/transfers/${t.id}`)).json.files[0].scanStatus, (await api('GET', `/api/transfers/${t.id}`)).json.status);
await api('PUT', `/api/transfers/${t.id}/recipients`, { emails: ['sam@example.invalid'] });
// wait for worker (must be running) to scan
for (let i = 0; i < 30; i++) { const d = (await api('GET', `/api/transfers/${t.id}`)).json; if (d.status === 'ready' || d.files[0].scanStatus !== 'pending' && d.files[0].scanStatus !== 'scanning') { console.log('scan', d.files[0].scanStatus, d.status, d.blockingReasons); break; } await new Promise(r => setTimeout(r, 1000)); }
const sent = (await api('POST', `/api/transfers/${t.id}/send`, {})).json;
console.log('sent', sent.status, sent.grants[0].status);
// find invitation mail
let link;
for (let i = 0; i < 30; i++) {
  const dir = '/home/user/LFS-Upload/var/mail';
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  for (const fn of files.reverse()) { const txt = fs.readFileSync(path.join(dir, fn), 'utf8'); const m = txt.match(/http:\/\/localhost:3000\/r\/[A-Za-z0-9_-]+/); if (m && txt.includes('sam@example.invalid') && txt.includes('has sent you')) { link = m[0]; break; } }
  if (link) break; await new Promise(r => setTimeout(r, 1000));
}
console.log('invitation link found', !!link);
const token = link.split('/r/')[1];
cookie = '';
console.log('public', (await api('GET', `/api/r/${token}`)).json.state);
const requestedAt = Date.now();
console.log('code req', (await api('POST', `/api/r/${token}/code`, {})).json);
let code;
for (let i = 0; i < 30; i++) { const dir = '/home/user/LFS-Upload/var/mail'; for (const fn of fs.readdirSync(dir).sort().reverse()) { if (Number(fn.split('-')[0]) < requestedAt - 1000) continue; const txt = fs.readFileSync(path.join(dir, fn), 'utf8'); if (txt.includes('verification code')) { code = txt.match(/code is: (\d{6})/)[1]; break; } } if (code) break; await new Promise(r => setTimeout(r, 1000)); }
console.log('wrong code', (await api('POST', `/api/r/${token}/verify`, { code: '000000' }, { allowFail: true })).status);
const v = (await api('POST', `/api/r/${token}/verify`, { code })).json;
console.log('verified; files', v.view.files.map(x => x.name), 'recipient', v.view.recipientEmail);
const r1 = await fetch(BASE + `/api/r/${token}/files/${v.view.files[0].id}`, { headers: { cookie, range: 'bytes=0-1048575' } });
console.log('range', r1.status, r1.headers.get('content-range'), r1.headers.get('content-disposition'));
const b1 = Buffer.from(await r1.arrayBuffer());
const r2 = await fetch(BASE + `/api/r/${token}/files/${v.view.files[0].id}`, { headers: { cookie, range: 'bytes=1048576-' } });
const b2 = Buffer.from(await r2.arrayBuffer());
console.log('full equal', Buffer.concat([b1, b2]).equals(data));
await new Promise(r => setTimeout(r, 500));
const act = (await api('GET', `/api/r/${token}/view`)).json;
console.log('downloadsRemaining', act.downloadsRemaining);

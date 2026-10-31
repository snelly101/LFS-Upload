import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import { ADMIN, countMail, freshTotpCode, waitForMail } from '../helpers/env.js';

/**
 * Critical recipient journey on a mobile viewport: open the invitation link, explicitly request a code,
 * verify with the emailed code, see the file list and download the file. Also checks that nothing
 * sensitive is shown before verification and that the link alone sends no code.
 */
async function apiLogin(request: import('@playwright/test').APIRequestContext) {
  const h = { 'x-requested-with': 'snelson' };
  await request.post('http://localhost:3000/api/auth/login', { headers: h, data: { email: ADMIN.email, password: ADMIN.password } });
  let r = await request.post('http://localhost:3000/api/auth/mfa/totp/verify', { headers: h, data: { code: await freshTotpCode() } });
  if (!r.ok()) {
    // The current 30 s step may have been consumed by something outside this run; wait for the next one.
    await new Promise((res) => setTimeout(res, 30_000 - (Date.now() % 30_000) + 500));
    r = await request.post('http://localhost:3000/api/auth/mfa/totp/verify', { headers: h, data: { code: await freshTotpCode() } });
  }
  if (!r.ok()) throw new Error('API MFA login failed: ' + (await r.text()));
  return h;
}

test('recipient verifies by email code and downloads on mobile', async ({ page, request }) => {
  // Arrange a sent transfer through the API (the sender UI journey is covered separately).
  const h = await apiLogin(request);
  const t = await (await request.post('http://localhost:3000/api/transfers', { headers: h, data: { title: 'Mobile recipient test', message: 'For the mobile journey' } })).json();
  const bytes = Buffer.alloc(1_000_000, 42);
  const f = await (await request.post(`http://localhost:3000/api/transfers/${t.id}/files`, { headers: h, data: { name: 'photo-set.bin', sizeBytes: bytes.length } })).json();
  const cr = await request.post('http://localhost:3000/api/uploads/tus', { headers: { ...h, 'tus-resumable': '1.0.0', 'upload-length': String(bytes.length), 'upload-metadata': `uploadId ${Buffer.from(f.uploadId).toString('base64')}` } });
  const loc = cr.headers()['location']!;
  await request.patch('http://localhost:3000' + loc, { headers: { ...h, 'tus-resumable': '1.0.0', 'upload-offset': '0', 'content-type': 'application/offset+octet-stream' }, data: bytes });
  await request.put(`http://localhost:3000/api/transfers/${t.id}/recipients`, { headers: h, data: { emails: ['mobile-recipient@example.invalid'] } });
  for (let i = 0; i < 60; i++) {
    const d = await (await request.get(`http://localhost:3000/api/transfers/${t.id}`, { headers: h })).json();
    if (d.status === 'ready') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const sentAt = Date.now();
  const sent = await (await request.post(`http://localhost:3000/api/transfers/${t.id}/send`, { headers: h, data: {} })).json();
  expect(sent.status).toBe('active');
  const mail = await waitForMail((x) => x.includes('mobile-recipient@example.invalid') && x.includes('has sent you'), 30_000, sentAt);
  const link = mail.match(/http:\/\/localhost:3000\/r\/[A-Za-z0-9_-]+/)![0].replace('http://localhost:3000', '');
  const isCodeMail = (x: string) => x.includes('mobile-recipient@example.invalid') && x.includes('verification code');
  const codeMailsBefore = countMail(isCodeMail);

  // Act: open the link. Nothing sensitive before verification, and no code is sent automatically.
  await page.goto(link);
  await expect(page.getByRole('button', { name: /email me a code|send.*code/i })).toBeVisible();
  await expect(page.getByText('Mobile recipient test')).toHaveCount(0);
  await expect(page.getByText('photo-set.bin')).toHaveCount(0);
  await page.waitForTimeout(1500);
  expect(countMail(isCodeMail)).toBe(codeMailsBefore);

  await page.getByRole('button', { name: /email me a code|send.*code/i }).click();
  const requestedAt = Date.now();
  const codeMail = await waitForMail((x) => isCodeMail(x) && !x.includes('has sent you'), 30_000, requestedAt);
  const code = codeMail.match(/code is: (\d{6})/)![1]!;
  await page.getByLabel(/code/i).first().fill(code);
  await page.keyboard.press('Enter');

  await expect(page.getByText('Mobile recipient test')).toBeVisible();
  await expect(page.getByText('photo-set.bin')).toBeVisible();
  await expect(page.getByText(/available until|expires/i).first()).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: /photo-set\.bin|download/i }).first().click()]);
  const path = await download.path();
  expect(path).toBeTruthy();
  expect(fs.statSync(path!).size).toBe(bytes.length);

  // Server-side completion recorded (not just the click): sender sees the completed download.
  let last: unknown = null;
  for (let i = 0; i < 60; i++) {
    const res = await request.get(`http://localhost:3000/api/transfers/${t.id}`, { headers: h });
    last = await res.json();
    if ((last as { grants: { filesCompleted: number }[] }).grants?.[0]?.filesCompleted === 1) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('download completion was not recorded: ' + JSON.stringify(last).slice(0, 500));
});

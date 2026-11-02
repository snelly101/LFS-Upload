// Drives the UI with Playwright to verify the main flows and capture screenshots for docs/.
import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs';
import * as OTPAuth from '/home/user/LFS-Upload/apps/api/node_modules/otpauth/dist/otpauth.node.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const OUT = '/home/user/LFS-Upload/docs/screenshots';
const MAIL = '/home/user/LFS-Upload/var/mail';
const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(process.argv[2] ?? 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP') });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome', args: ['--no-sandbox'] });
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
const shot = (name, p = page) => p.screenshot({ path: path.join(OUT, name), fullPage: true });
const newestMail = (pred, since) => {
  for (const fn of fs.readdirSync(MAIL).sort().reverse()) {
    if (Number(fn.split('-')[0]) < since - 1000) continue;
    const txt = fs.readFileSync(path.join(MAIL, fn), 'utf8');
    if (pred(txt)) return txt;
  }
  return null;
};
const waitMail = async (pred, since) => { for (let i = 0; i < 40; i++) { const m = newestMail(pred, since); if (m) return m; await new Promise((r) => setTimeout(r, 750)); } throw new Error('mail not found'); };
const waitStep = async () => { await new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 400)); };

// ---- sign in (sender account) ----
await page.goto(`${BASE}/login`);
await page.waitForSelector('#email');
await shot('login.png');
await page.fill('#email', 'alex.sender@dev.securesend.invalid');
await page.fill('#password', 'correct-horse-battery-staple-2026');
await page.click('button:has-text("Continue")');
await page.waitForSelector('#mfa-code');
await shot('login-mfa.png');
await page.fill('#mfa-code', totp.generate());
await page.click('button:has-text("Continue")');
try { await page.waitForURL((u) => new URL(u).pathname === '/', { timeout: 8000 }); } catch { await waitStep(); await page.fill('#mfa-code', totp.generate()); await page.click('button:has-text("Continue")'); await page.waitForURL((u) => new URL(u).pathname === '/'); }
await page.waitForSelector('text=Send files securely');
await shot('home-empty.png');

// ---- compose: drop a file, address it, send ----
const tmp = '/tmp/ui-upload-sample.bin';
fs.writeFileSync(tmp, Buffer.alloc(2 * 1024 * 1024 + 77, 3));
const tmp2 = '/tmp/ui-upload-sample-2.pdf';
fs.writeFileSync(tmp2, Buffer.alloc(900 * 1024, 9));
await page.setInputFiles('input[type=file][multiple]', [tmp, tmp2]);
await page.waitForSelector('#recipients');
await page.fill('#recipients', 'sam.recipient@example.invalid');
await page.keyboard.press('Enter');
await page.fill('#title', 'Site survey photos');
await page.waitForFunction(() => document.body.innerText.includes('Ready to send'), null, { timeout: 60_000 });
await shot('home-composer.png');
// open the expiry picker to show the sentence controls
await page.click('button[aria-label="How long the files are available"]');
await page.waitForSelector('[role=menu]');
await shot('home-picker.png');
await page.keyboard.press('Escape');
const sentAt = Date.now();
await page.click('button:has-text("Send 2 files")');
await page.waitForSelector('text=Sent to Sam');
await shot('home-sent.png');
await page.click('a:has-text("Track it")');
await page.waitForURL(/\/sent\//);
await page.waitForSelector('text=Recipients');
await page.waitForTimeout(1200);
await shot('detail-waiting.png');
const transferUrl = page.url();

// ---- recipient flow (fresh mobile context) ----
const mail = await waitMail((t) => t.includes('sam.recipient@example.invalid') && t.includes('has sent you'), sentAt);
const link = mail.match(/http:\/\/localhost:3000\/r\/[A-Za-z0-9_-]+/)[0].replace('http://localhost:3000', BASE);
const rctx = await browser.newContext({ viewport: { width: 412, height: 860 }, isMobile: true, hasTouch: true });
const rp = await rctx.newPage();
rp.on('console', (m) => { if (m.type() === 'error') errors.push(`[rcpt console] ${m.text()}`); });
rp.on('pageerror', (e) => errors.push(`[rcpt pageerror] ${e.message}`));
await rp.goto(link);
await rp.waitForSelector('text=Email me a code');
await shot('recipient-verify-mobile.png', rp);
const codeAt = Date.now();
await rp.click('text=Email me a code');
await rp.waitForSelector('#code');
const codeMail = await waitMail((t) => t.includes('sam.recipient@example.invalid') && t.includes('verification code'), codeAt);
await rp.fill('#code', codeMail.match(/code is: (\d{6})/)[1]);
await rp.click('button:has-text("Open transfer")');
await rp.waitForSelector('text=Download all');
await shot('recipient-files-mobile.png', rp);
const dl = await Promise.all([rp.waitForEvent('download'), rp.click('a[aria-label^="Download ui-upload-sample.bin"]')]);
await dl[0].path();
const dp = await rctx.newPage();
await dp.setViewportSize({ width: 1100, height: 760 });
await dp.goto(link);
await dp.waitForSelector('text=Download all');
await shot('recipient-files.png', dp);

// ---- sender sees progress ----
await page.reload();
await page.waitForFunction(() => document.body.innerText.includes('Opened'), null, { timeout: 30_000 });
await page.waitForTimeout(800);
await shot('detail-progress.png');
await page.goto(`${BASE}/sent`);
await page.waitForSelector('.sent-row');
await shot('sent-list.png');

// ---- mobile staff views ----
await page.setViewportSize({ width: 400, height: 820 });
await page.goto(`${BASE}/`);
await page.waitForSelector('text=Send files securely');
await shot('home-mobile.png');
await page.goto(transferUrl);
await page.waitForSelector('text=Recipients');
await page.waitForTimeout(800);
await shot('detail-mobile.png');
await page.setViewportSize({ width: 1280, height: 820 });

// ---- admin (separate account) ----
const actx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
const ap = await actx.newPage();
ap.on('console', (m) => { if (m.type() === 'error') errors.push(`[admin console] ${m.text()}`); });
ap.on('pageerror', (e) => errors.push(`[admin pageerror] ${e.message}`));
await ap.goto(`${BASE}/login`);
await ap.fill('#email', 'admin@dev.securesend.invalid');
await ap.fill('#password', 'correct-horse-battery-staple-2026');
await ap.click('button:has-text("Continue")');
await ap.waitForSelector('#mfa-code');
await ap.fill('#mfa-code', totp.generate());
await ap.click('button:has-text("Continue")');
try { await ap.waitForURL((u) => new URL(u).pathname === '/', { timeout: 8000 }); } catch { await waitStep(); await ap.fill('#mfa-code', totp.generate()); await ap.click('button:has-text("Continue")'); await ap.waitForURL((u) => new URL(u).pathname === '/'); }
await ap.goto(`${BASE}/admin/health`);
await ap.waitForSelector('text=Job queue');
await shot('admin-health.png', ap);
await ap.goto(`${BASE}/admin/verification`);
await ap.waitForSelector('#v-mode');
await shot('admin-verification.png', ap);
await ap.goto(`${BASE}/activity`);
await ap.waitForSelector('table.table');
await shot('activity.png', ap);

// keyboard: first Tab lands on the skip link
await page.goto(`${BASE}/`);
await page.waitForSelector('text=Send files securely');
await page.keyboard.press('Tab');
console.log('first tab focus:', await page.evaluate(() => document.activeElement?.className));
for (const f of ['transfers-list.png', 'transfers-list-mobile.png', 'new-transfer.png', 'transfer-detail.png']) { try { fs.unlinkSync(path.join(OUT, f)); } catch { /* gone */ } }
console.log('transfer:', transferUrl);
console.log('errors:', errors.length ? errors : 'none');
await browser.close();

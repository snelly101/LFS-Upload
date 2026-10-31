// Drives the UI with Playwright to verify the main flows and capture screenshots for docs/.
import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs';
import * as OTPAuth from '/home/user/LFS-Upload/apps/api/node_modules/otpauth/dist/otpauth.node.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const OUT = '/home/user/LFS-Upload/docs/screenshots';
const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(process.argv[2] ?? 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP') });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome', args: ['--no-sandbox'] });
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
const shot = (name) => page.screenshot({ path: path.join(OUT, name), fullPage: true });

await page.goto(`${BASE}/login`);
await page.waitForSelector('#email');
await shot('login.png');
await page.fill('#email', 'admin@dev.snelson.invalid');
await page.fill('#password', 'correct-horse-battery-staple-2026');
await page.click('button:has-text("Continue")');
await page.waitForSelector('#mfa-code');
await shot('login-mfa.png');
await page.fill('#mfa-code', totp.generate());
await page.click('button:has-text("Continue")');
await page.waitForURL(/\/transfers/);
await page.waitForSelector('table.table, .empty');
await shot('transfers-list.png');

// New transfer: upload a file through the real composer
await page.goto(`${BASE}/transfers/new`);
await page.waitForSelector('#recipients');
const tmp = '/tmp/ui-upload-sample.bin';
fs.writeFileSync(tmp, Buffer.alloc(2 * 1024 * 1024 + 77, 3));
await page.setInputFiles('input[type=file][multiple]', tmp);
await page.fill('#recipients', 'sam.recipient@example.invalid');
await page.keyboard.press('Enter');
await page.fill('#title', 'Site survey photos');
await page.fill('#msg', 'Photos from the Tuesday visit. Let me know if anything is missing.');
await page.waitForFunction(() => document.body.innerText.includes('Scan passed'), null, { timeout: 60_000 });
await shot('new-transfer.png');
await page.click('button:has-text("Send to")');
await page.waitForSelector('text=Invitations are on their way');
await page.click('a:has-text("View transfer")');
await page.waitForSelector('text=Activity receipt');
await page.waitForTimeout(1500);
await shot('transfer-detail.png');
const transferUrl = page.url();

await page.goto(`${BASE}/admin/health`);
await page.waitForSelector('text=Job queue');
await shot('admin-health.png');
await page.goto(`${BASE}/admin/verification`);
await page.waitForSelector('#v-mode');
await shot('admin-verification.png');
await page.goto(`${BASE}/activity`);
await page.waitForSelector('table.table');
await shot('activity.png');

// Recipient flow in a fresh context (no staff cookies)
let link;
for (let i = 0; i < 30 && !link; i++) {
  const dir = '/home/user/LFS-Upload/var/mail';
  for (const fn of fs.readdirSync(dir).sort().reverse()) {
    const txt = fs.readFileSync(path.join(dir, fn), 'utf8');
    if (txt.includes('sam.recipient@example.invalid') && txt.includes('has sent you')) { link = txt.match(/http:\/\/localhost:3000\/r\/[A-Za-z0-9_-]+/)[0]; break; }
  }
  if (!link) await new Promise((r) => setTimeout(r, 1000));
}
const rctx = await browser.newContext({ viewport: { width: 420, height: 860 }, isMobile: true, hasTouch: true });
const rp = await rctx.newPage();
rp.on('console', (m) => { if (m.type() === 'error') errors.push(`[rcpt console] ${m.text()}`); });
rp.on('pageerror', (e) => errors.push(`[rcpt pageerror] ${e.message}`));
await rp.goto(link.replace('http://localhost:3000', BASE));
await rp.waitForSelector('text=Email me a code');
await rp.screenshot({ path: path.join(OUT, 'recipient-verify-mobile.png'), fullPage: true });
const before = new Set(fs.readdirSync('/home/user/LFS-Upload/var/mail'));
await rp.click('text=Email me a code');
await rp.waitForSelector('#code');
let code;
for (let i = 0; i < 30 && !code; i++) {
  const dir = '/home/user/LFS-Upload/var/mail';
  for (const fn of fs.readdirSync(dir).filter((f) => !before.has(f))) { const txt = fs.readFileSync(path.join(dir, fn), 'utf8'); if (txt.includes('verification code')) { code = txt.match(/code is: (\d{6})/)[1]; break; } }
  if (!code) await new Promise((r) => setTimeout(r, 1000));
}
await rp.fill('#code', code);
await rp.click('button:has-text("Open transfer")');
await rp.waitForSelector('text=Download');
await rp.screenshot({ path: path.join(OUT, 'recipient-files-mobile.png'), fullPage: true });
// desktop recipient page
const dp = await rctx.newPage();
await dp.setViewportSize({ width: 1100, height: 760 });
await dp.goto(link.replace('http://localhost:3000', BASE));
await dp.waitForSelector('text=Download');
await dp.screenshot({ path: path.join(OUT, 'recipient-files.png'), fullPage: true });

// Keyboard navigation check on the composer: tab to recipients and type
await page.goto(`${BASE}/transfers/new`);
await page.waitForSelector('#recipients');
await page.keyboard.press('Tab');
const focused = await page.evaluate(() => document.activeElement?.className);
console.log('first tab focus:', focused);

// mobile staff list
await page.setViewportSize({ width: 400, height: 800 });
await page.goto(`${BASE}/transfers`);
await page.waitForSelector('table.table');
await shot('transfers-list-mobile.png');

console.log('transfer:', transferUrl);
console.log('errors:', errors.length ? errors : 'none');
await browser.close();

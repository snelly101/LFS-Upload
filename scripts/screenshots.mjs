// Drives the real UI with Playwright to verify the main flows and capture screenshots for docs/.
// Usage: node scripts/screenshots.mjs [totp-secret]   (dev stack must be up: scripts/dev-up.sh)
import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs';
import * as OTPAuth from '/home/user/LFS-Upload/apps/api/node_modules/otpauth/dist/otpauth.node.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const OUT = '/home/user/LFS-Upload/docs/screenshots';
const MAIL = '/home/user/LFS-Upload/var/mail';
const SECRET = process.argv[2] ?? 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PASSWORD = 'correct-horse-battery-staple-2026';
const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(SECRET) });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome', args: ['--no-sandbox'] });
const errors = [];
const notFound = [];
const watch = (p, tag) => {
  p.on('console', (m) => {
    if (m.type() !== 'error') return;
    // Optional endpoints (live events, contacts) may be absent on an older API; the UI falls back.
    if (/status of 404/.test(m.text())) { notFound.push(`[${tag}] ${m.location()?.url ?? ''}`); return; }
    errors.push(`[${tag} console] ${m.text()}`);
  });
  p.on('pageerror', (e) => errors.push(`[${tag} pageerror] ${e.message}`));
};
const shot = async (name, p) => { await p.evaluate(() => { window.scrollTo(0, 0); return document.fonts.ready; }); await p.screenshot({ path: path.join(OUT, name), fullPage: true }); };
const newestMail = (pred, since) => {
  for (const fn of fs.readdirSync(MAIL).sort().reverse()) {
    if (Number(fn.split('-')[0]) < since - 1000) continue;
    const txt = fs.readFileSync(path.join(MAIL, fn), 'utf8');
    if (pred(txt)) return txt;
  }
  return null;
};
const waitMail = async (pred, since) => { for (let i = 0; i < 40; i++) { const m = newestMail(pred, since); if (m) return m; await new Promise((r) => setTimeout(r, 750)); } throw new Error('mail not found'); };
const waitStep = () => new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 400));
const atHome = (u) => new URL(u).pathname === '/';
async function signIn(p, email, firstShots = false) {
  await p.goto(`${BASE}/login`);
  await p.waitForSelector('#email');
  if (firstShots) await shot('login.png', p);
  await p.fill('#email', email);
  await p.fill('#password', PASSWORD);
  await p.click('button:has-text("Continue")');
  await p.waitForSelector('#mfa-code');
  if (firstShots) await shot('login-mfa.png', p);
  await p.fill('#mfa-code', totp.generate());
  await p.click('button:has-text("Continue")');
  try { await p.waitForURL(atHome, { timeout: 8000 }); } catch { await waitStep(); await p.fill('#mfa-code', totp.generate()); await p.click('button:has-text("Continue")'); await p.waitForURL(atHome); }
}
const H = { 'X-Requested-With': 'securesend' };

// ---------------------------------------------------------------- sender
const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
watch(page, 'sender');
await signIn(page, 'alex.sender@dev.securesend.invalid', true);
await page.waitForSelector('text=Send files securely');
await shot('home-empty.png', page);

const tmp = '/tmp/ui-upload-sample.bin';
fs.writeFileSync(tmp, Buffer.alloc(2 * 1024 * 1024 + 77, 3));
const tmp2 = '/tmp/ui-upload-sample-2.pdf';
fs.writeFileSync(tmp2, Buffer.alloc(900 * 1024, 9));
await page.setInputFiles('input[type=file][multiple]', [tmp, tmp2]);
await page.waitForSelector('#recipients');
await page.fill('#recipients', 'sam.recipient@example.invalid');
await page.keyboard.press('Enter');
await page.fill('#title', 'Site survey photos');
await page.waitForFunction(() => document.querySelector('.composer .overall strong')?.textContent?.includes('Ready to send'), null, { timeout: 60_000 });
await shot('home-composer.png', page);
await page.click('button[aria-label="How long the files are available"]');
await page.waitForSelector('[role=menu]');
await shot('home-picker.png', page);
await page.keyboard.press('Escape');
const sentAt = Date.now();
await page.click('button:has-text("Send 2 files")');
await page.waitForSelector('text=Sent to Sam');
await shot('home-sent.png', page);
await page.click('a:has-text("Track it")');
await page.waitForURL(/\/sent\//);
await page.waitForSelector('.people');
await page.waitForTimeout(1200);
await shot('detail-waiting.png', page);
const transferUrl = page.url();

// ---------------------------------------------------------------- recipient (fresh mobile context)
const mail = await waitMail((t) => t.includes('sam.recipient@example.invalid') && t.includes('has sent you'), sentAt);
const link = mail.match(/http:\/\/localhost:3000\/r\/[A-Za-z0-9_-]+/)[0].replace('http://localhost:3000', BASE);
const rctx = await browser.newContext({ viewport: { width: 412, height: 860 }, isMobile: true, hasTouch: true });
const rp = await rctx.newPage();
watch(rp, 'recipient');
await rp.goto(link);
await rp.waitForSelector('text=Email me a code');
await shot('recipient-verify-mobile.png', rp);
const codeAt = Date.now();
await rp.click('text=Email me a code');
await rp.waitForSelector('#code');
const codeMail = await waitMail((t) => t.includes('sam.recipient@example.invalid') && t.includes('verification code'), codeAt);
await rp.fill('#code', codeMail.match(/code is: (\d{6})/)[1]);
await shot('recipient-code-mobile.png', rp);
await rp.click('button:has-text("Open transfer")');
await rp.waitForSelector('text=Download all');
await shot('recipient-files-mobile.png', rp);
const dl = await Promise.all([rp.waitForEvent('download'), rp.click('a[aria-label^="Download ui-upload-sample.bin"]')]);
await dl[0].path();
const dp = await rctx.newPage();
watch(dp, 'recipient-desktop');
await dp.setViewportSize({ width: 1100, height: 760 });
await dp.goto(link);
await dp.waitForSelector('text=Download all');
await shot('recipient-files.png', dp);
// a dead link: calm, reveals nothing
const dead = await rctx.newPage();
await dead.setViewportSize({ width: 1100, height: 620 });
await dead.goto(`${BASE}/r/${'x'.repeat(43)}`);
await dead.waitForSelector("text=This link isn't recognised");
await shot('recipient-dead-link.png', dead);
await dead.close();

// ---------------------------------------------------------------- sender sees progress
await page.goto(transferUrl);
await page.waitForFunction(() => document.body.innerText.includes('Opened'), null, { timeout: 30_000 });
await page.waitForTimeout(800);
await shot('detail-progress.png', page);
await page.goto(`${BASE}/sent`);
await page.waitForSelector('.sent-row');
await shot('sent-list.png', page);
await page.goto(`${BASE}/activity`);
await page.waitForSelector('.log-row');
await page.click('.log-row:nth-child(3) > summary');
await shot('activity.png', page);
await page.goto(`${BASE}/notifications`);
await page.waitForSelector('h1:has-text("Notifications")');
await page.waitForTimeout(500);
await shot('notifications.png', page);
await page.goto(`${BASE}/account/security`);
await page.waitForSelector('h2:has-text("Sessions")');
await shot('account-security.png', page);

// mobile staff views
await page.setViewportSize({ width: 400, height: 820 });
await page.goto(`${BASE}/`);
await page.waitForSelector('text=Send files securely');
await shot('home-mobile.png', page);
await page.goto(transferUrl);
await page.waitForSelector('.people');
await page.waitForTimeout(800);
await shot('detail-mobile.png', page);
await page.goto(`${BASE}/activity`);
await page.waitForSelector('.log-row');
await shot('activity-mobile.png', page);
await page.setViewportSize({ width: 1280, height: 820 });

// a draft with files, reused for the theme matrix
await page.goto(`${BASE}/`);
await page.waitForSelector('text=Send files securely');
await page.setInputFiles('input[type=file][multiple]', [tmp, tmp2]);
await page.waitForFunction(() => document.body.innerText.includes('Scan passed'), null, { timeout: 60_000 });
const drafts = await (await page.request.get(`${BASE}/api/transfers?status=draft&pageSize=1`)).json();
const draftId = drafts.items[0]?.id;

// ---------------------------------------------------------------- admin
const actx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
const ap = await actx.newPage();
watch(ap, 'admin');
await signIn(ap, 'admin@dev.securesend.invalid');
await ap.goto(`${BASE}/admin`);
await ap.waitForSelector('.stat-grid');
await shot('admin-health.png', ap);
await ap.goto(`${BASE}/admin/verification`);
await ap.waitForSelector('text=How recipients prove who they are');
await shot('admin-verification.png', ap);
await ap.goto(`${BASE}/admin/transfer-policy`);
await ap.waitForSelector('text=What can be sent');
await ap.waitForSelector('#t-file');
await shot('admin-transfer-policy.png', ap);
await ap.goto(`${BASE}/admin/branding`);
await ap.waitForSelector('text=Accent colour');
await shot('admin-branding.png', ap);
await ap.goto(`${BASE}/admin/notifications`);
await ap.waitForSelector('text=What senders are told');
await ap.click('button:has-text("Preview with sample details")');
await ap.waitForSelector('iframe[title="Email preview"]');
await ap.waitForTimeout(400);
await shot('admin-email.png', ap);
await ap.goto(`${BASE}/admin/users`);
await ap.waitForSelector('table.table');
await shot('admin-people.png', ap);

// ---------------------------------------------------------------- theme matrix
const settings = await (await ap.request.get(`${BASE}/api/admin/settings`)).json();
const branding = settings.settings.branding;
const setTheme = async (theme) => {
  const r = await ap.request.put(`${BASE}/api/admin/settings/branding`, { headers: H, data: { value: { ...branding, theme, colourScheme: 'auto' }, reason: '' } });
  if (!r.ok()) throw new Error(`could not set theme: ${r.status()} ${await r.text()}`);
};
try {
  for (const theme of ['civic', 'clear']) {
    await setTheme(theme);
    for (const scheme of ['light', 'dark']) {
      const tag = `theme-${theme}-${scheme}`;
      await page.emulateMedia({ colorScheme: scheme });
      await dp.emulateMedia({ colorScheme: scheme });
      if (draftId) {
        await page.goto(`${BASE}/?id=${draftId}`);
        await page.waitForSelector('#recipients');
        await page.waitForFunction(() => document.documentElement.dataset.theme && document.body.innerText.includes('Scan passed'));
        await page.waitForFunction((t) => document.documentElement.dataset.theme === t, theme);
        await page.fill('#recipients', 'sam.recipient@example.invalid');
        await page.keyboard.press('Enter');
        await page.fill('#title', 'Site survey photos');
        await page.locator('#title').blur();
        await shot(`${tag}-home.png`, page);
      }
      await page.goto(transferUrl);
      await page.waitForSelector('.people');
      await page.waitForFunction((t) => document.documentElement.dataset.theme === t, theme);
      await page.waitForTimeout(400);
      await shot(`${tag}-detail.png`, page);
      await dp.goto(link);
      await dp.waitForSelector('text=Download all');
      await dp.waitForFunction((t) => document.documentElement.dataset.theme === t, theme);
      await shot(`${tag}-recipient.png`, dp);
    }
  }
} finally {
  await setTheme('civic');
  await page.emulateMedia({ colorScheme: 'light' });
  await dp.emulateMedia({ colorScheme: 'light' });
}
// leave no stray draft behind
if (draftId) await page.request.post(`${BASE}/api/transfers/${draftId}/delete-now`, { headers: H, data: {} }).catch(() => undefined);

// ---------------------------------------------------------------- authenticator enrolment (QR)
try {
  const email = `qr.demo.${Date.now()}@dev.securesend.invalid`;
  const inv = await ap.request.post(`${BASE}/api/admin/users/invite`, { headers: H, data: { email, displayName: 'Quinn Demo', role: 'sender' } });
  const invJson = await inv.json();
  if (invJson.invitationLink) {
    const ectx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const ep = await ectx.newPage();
    watch(ep, 'enrol');
    await ep.goto(invJson.invitationLink.replace('http://localhost:3000', BASE));
    await ep.waitForSelector('#pw');
    await ep.fill('#pw', PASSWORD);
    await ep.fill('#pw2', PASSWORD);
    await ep.click('button:has-text("Continue")');
    await ep.waitForSelector('text=Use an authenticator app');
    await ep.click('text=Use an authenticator app');
    await ep.waitForSelector('.qr svg');
    await shot('enrol-totp-qr.png', ep);
    await ectx.close();
  } else {
    console.log('QR screenshot skipped: invite response had no development link', inv.status());
  }
} catch (e) {
  console.log('QR screenshot skipped:', e.message);
}

// keyboard: first Tab lands on the skip link
await page.goto(`${BASE}/`);
await page.waitForSelector('text=Send files securely');
await page.keyboard.press('Tab');
console.log('first tab focus:', await page.evaluate(() => document.activeElement?.className));
for (const f of ['transfers-list.png', 'transfers-list-mobile.png', 'new-transfer.png', 'transfer-detail.png']) { try { fs.unlinkSync(path.join(OUT, f)); } catch { /* gone */ } }
console.log('transfer:', transferUrl);
console.log('404s (optional endpoints):', notFound.length ? [...new Set(notFound)] : 'none');
console.log('errors:', errors.length ? errors : 'none');
await browser.close();

import { devices, expect, test } from '@playwright/test';
import fs from 'node:fs';
import { loginAsSender } from '../helpers/login.js';
import { SENDER, countMail, makeFixture, waitForMail } from '../helpers/env.js';

/**
 * File request journey: a member of staff asks a named person for files through the UI; that person
 * opens their link on a phone, sees nothing until they verify, uploads through the real page and
 * sees it received; the member of staff then downloads the file from the request page.
 */
test('staff request files, a verified contributor uploads, staff download', async ({ page, browser }, testInfo) => {
  const baseURL = testInfo.project.use.baseURL ?? 'http://localhost:5173';
  const who = `contributor-${Date.now()}@example.invalid`;
  const title = `Signed agreement ${Date.now()}`;

  // --- staff: create the request ---------------------------------------------------------------
  await loginAsSender(page);
  await page.getByRole('link', { name: 'Request', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ask someone to send you files' })).toBeVisible();
  const from = page.getByLabel('Who should send the files');
  await expect(from).toBeFocused();
  await page.keyboard.type(who);
  await page.keyboard.press('Enter');
  await expect(page.getByText(who).first()).toBeVisible();
  await page.getByLabel('What do you need?').fill(title);
  await expect(page.getByText(/Each must verify by email code first/)).toBeVisible();
  const askedAt = Date.now();
  await page.getByRole('button', { name: /^Send request to / }).click();
  await expect(page.getByRole('heading', { name: /^Request sent to / })).toBeVisible({ timeout: 30_000 });

  const mail = await waitForMail((x) => x.includes(who) && x.includes('asked you to send files'), 30_000, askedAt);
  // Like every invitation, the email says nothing about what is being asked for.
  expect(mail).not.toContain(title);
  const link = mail.match(/http:\/\/localhost:3000\/r\/[A-Za-z0-9_-]+/)![0].replace('http://localhost:3000', baseURL);

  // --- contributor: a fresh phone-sized browser with no staff session ----------------------------
  const phone = await browser.newContext({ ...devices['Pixel 7'], baseURL });
  const cp = await phone.newPage();
  const pageErrors: string[] = [];
  cp.on('pageerror', (e) => pageErrors.push(String(e)));
  const isCodeMail = (x: string) => x.includes(who) && x.includes('verification code');
  const codeMailsBefore = countMail(isCodeMail);

  await cp.goto(link);
  await expect(cp.getByRole('heading', { name: 'You have been asked to send files' })).toBeVisible();
  // Nothing about the request before verification, nowhere to put a file, and no code sent by the visit.
  await expect(cp.getByText(title)).toHaveCount(0);
  await expect(cp.getByText(SENDER.email)).toHaveCount(0);
  await expect(cp.locator('input[type=file]')).toHaveCount(0);
  await cp.waitForTimeout(1000);
  expect(countMail(isCodeMail)).toBe(codeMailsBefore);

  await cp.getByRole('button', { name: 'Email me a code' }).click();
  const requestedAt = Date.now();
  const codeMail = await waitForMail(isCodeMail, 30_000, requestedAt);
  const code = codeMail.match(/code is: (\d{6})/)![1]!;
  await cp.getByLabel(/code/i).first().fill(code);
  await cp.keyboard.press('Enter');

  await expect(cp.getByRole('heading', { name: title })).toBeVisible();
  await expect(cp.getByText(SENDER.email).first()).toBeVisible();
  const fixture = makeFixture('contributed-scan.bin', 1_500_000 + 7);
  await cp.locator('input[type=file]').setInputFiles(fixture);
  await expect(cp.getByText('contributed-scan.bin')).toBeVisible();
  // Honest states: it only says "Received" once the upload has finished and passed the malware scan.
  await expect(cp.getByText('Received', { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(cp.getByText(/You can close this page/)).toBeVisible();
  // Contributors can never download, including their own files.
  await expect(cp.getByRole('link', { name: /download/i })).toHaveCount(0);
  expect(pageErrors).toEqual([]);
  await phone.close();

  // --- staff: the file is on the request page with its sender, and downloads intact --------------
  await page.getByRole('link', { name: 'Track it' }).click();
  await expect(page.locator('.files-in .fname', { hasText: 'contributed-scan.bin' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(`from ${who}`).first()).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(`1 file received from ${who}`);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download contributed-scan.bin' }).click()]);
  const saved = await download.path();
  expect(saved).toBeTruthy();
  expect(fs.statSync(saved!).size).toBe(fs.statSync(fixture).size);

  // And it shows up in the Sent list, marked as a request.
  await page.getByRole('link', { name: 'Sent', exact: true }).click();
  const row = page.locator('.sent-row', { hasText: title });
  await expect(row).toContainText('Request');
  await expect(row).toContainText('1 file received');
});

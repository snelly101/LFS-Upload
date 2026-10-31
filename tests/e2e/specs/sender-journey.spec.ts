import { expect, test } from '@playwright/test';
import { loginAsSender } from '../helpers/login.js';
import { makeFixture, waitForMail } from '../helpers/env.js';

/**
 * Critical sender journey: sign in with MFA, compose a transfer with keyboard-driven navigation,
 * upload a file (real tus upload), wait for the scan, add a recipient, review the plain-English
 * summary and send. Then the recipient journey is exercised in recipient-journey.spec.ts.
 */
test('sender creates, uploads, scans and sends a transfer (keyboard navigation)', async ({ page }) => {
  await loginAsSender(page);
  // Keyboard: Tab to the New transfer action from the top bar.
  await page.keyboard.press('Tab');
  const newTransfer = page.getByRole('link', { name: /new transfer/i }).first();
  await newTransfer.focus();
  await expect(newTransfer).toBeFocused();
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/transfers\/new/);

  const title = page.getByLabel(/title/i);
  await title.fill('E2E dispatch ' + Date.now());
  const recipients = page.getByLabel(/recipient/i).first();
  await recipients.fill('e2e-recipient@example.invalid');
  await page.keyboard.press('Enter');
  await expect(page.getByText('e2e-recipient@example.invalid')).toBeVisible();

  const fixture = makeFixture('e2e-document.bin', 2 * 1024 * 1024 + 11);
  await page.locator('input[type=file]').first().setInputFiles(fixture);
  await expect(page.getByText(/e2e-document\.bin/)).toBeVisible();
  // upload + scan: wait for the ready state in the UI (honest label), not a fake bar
  await expect(page.getByText(/ready to send|scan passed|clean/i).first()).toBeVisible({ timeout: 90_000 });

  await expect(page.getByText(/Only these 1 recipient|Only this recipient|1 recipient/i).first()).toBeVisible();
  await expect(page.getByText(/Email verification required/i).first()).toBeVisible();
  const sentAt = Date.now();
  const send = page.getByRole('button', { name: /^send/i }).first();
  await send.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText(/active|invitation/i).first()).toBeVisible({ timeout: 30_000 });

  const mail = await waitForMail((t) => t.includes('e2e-recipient@example.invalid') && t.includes('has sent you'), 30_000, sentAt);
  expect(mail).toMatch(/\/r\/[A-Za-z0-9_-]{40,}/);
  // The invitation must not reveal the filename.
  expect(mail).not.toContain('e2e-document.bin');
});

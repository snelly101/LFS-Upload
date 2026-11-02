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
  // Sending is the home page: the first Tab lands on the skip link, then the brand, then "Send".
  await page.goto('/');
  await page.getByText('Send files securely').waitFor();
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip-link')).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Send', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.waitForURL((u) => new URL(u).pathname === '/');

  // Files first: the composer appears once a file is chosen, and focus moves to "To".
  const fixture = makeFixture('e2e-document.bin', 2 * 1024 * 1024 + 11);
  await page.locator('input[type=file]').first().setInputFiles(fixture);
  await expect(page.getByText(/e2e-document\.bin/)).toBeVisible();
  const recipients = page.getByLabel(/recipients/i).first();
  await expect(recipients).toBeFocused();
  await page.keyboard.type('e2e-recipient@example.invalid');
  await page.keyboard.press('Enter');
  await expect(page.getByText('e2e-recipient@example.invalid').first()).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel(/title/i)).toBeFocused();
  await page.keyboard.type('E2E dispatch ' + Date.now());
  // upload + scan: wait for the ready state in the UI (honest label), not a fake bar
  await expect(page.getByText(/ready to send|scan passed|clean/i).first()).toBeVisible({ timeout: 90_000 });

  await expect(page.getByText(/Only these 1 recipient|Only this recipient|1 recipient/i).first()).toBeVisible();
  await expect(page.getByText(/Email verification required/i).first()).toBeVisible();
  const sentAt = Date.now();
  const send = page.getByRole('button', { name: /^send/i }).first();
  await send.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText(/^Sent to /).first()).toBeVisible({ timeout: 30_000 });

  const mail = await waitForMail((t) => t.includes('e2e-recipient@example.invalid') && t.includes('has sent you'), 30_000, sentAt);
  expect(mail).toMatch(/\/r\/[A-Za-z0-9_-]{40,}/);
  // The invitation must not reveal the filename.
  expect(mail).not.toContain('e2e-document.bin');
});

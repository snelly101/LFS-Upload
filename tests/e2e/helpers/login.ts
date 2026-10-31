import type { Page } from '@playwright/test';
import { ADMIN, totpCode } from './env.js';

/** Sign in through the real UI using the keyboard where practical. */
export async function loginAsAdmin(page: Page) {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(ADMIN.email);
  await page.getByLabel(/password/i).fill(ADMIN.password);
  await page.keyboard.press('Enter');
  const code = page.getByLabel(/code/i).first();
  await code.waitFor({ timeout: 15_000 });
  await code.fill(totpCode());
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/transfers/, { timeout: 20_000 });
}

import type { Page } from '@playwright/test';
import { ADMIN, SENDER, freshTotpCode } from './env.js';

/** Sign in through the real UI using the keyboard where practical. */
export async function loginAs(page: Page, account: { email: string; password: string; totpSecret: string }) {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(account.email);
  await page.getByLabel(/password/i).fill(account.password);
  await page.keyboard.press('Enter');
  const code = page.getByLabel(/code/i).first();
  await code.waitFor({ timeout: 15_000 });
  await code.fill(await freshTotpCode(account.totpSecret));
  await page.keyboard.press('Enter');
  try {
    await page.waitForURL(/\/transfers/, { timeout: 10_000 });
  } catch {
    // One-time code already used this step (e.g. by another process): wait for the next step and retry once.
    await new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 500));
    await code.fill(await freshTotpCode(account.totpSecret));
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/transfers/, { timeout: 20_000 });
  }
}
export const loginAsAdmin = (page: Page) => loginAs(page, ADMIN);
export const loginAsSender = (page: Page) => loginAs(page, SENDER);

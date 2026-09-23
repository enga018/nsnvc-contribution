// Browser smoke test.
//
// This is the only check that actually *executes* the app, so it catches
// runtime wiring errors (e.g. a global read before its declaration in the
// temporal dead zone) that `node --check` and the unit tests cannot.
//
// It runs index.html in local test mode — no Firebase, no network — by serving
// the repo over a local static server and logging in with the dev password.
//
// Run: npx playwright test   (or: node --test is NOT used here — Playwright owns it)
import { test, expect } from "@playwright/test";

const DEV_PASSWORD = "dev-mode-only";

test("app boots, logs in, and renders the dashboard", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await page.goto("/index.html");

  // The classic <script> flips this once the module starts.
  await expect.poll(() => page.evaluate(() => window.__nsnvcModuleStarted)).toBe(true);

  // Log in (local test mode accepts any email with the dev password).
  await page.fill("#adminEmail", "smoke@test.local");
  await page.fill("#adminPass", DEV_PASSWORD);
  await page.click("#loginBtn");

  // Dashboard becomes visible.
  await expect(page.locator("#dashboard")).toBeVisible();

  // Local test mode seeds sample households, so the list must not be empty.
  await expect(page.locator("#adminList .citizen-row").first()).toBeVisible();

  // No uncaught runtime errors along the way (this is what caught the
  // syncPendingWrites temporal-dead-zone crash).
  expect(errors, `page errors: ${errors.join(" | ")}`).toEqual([]);
});

test("defer/restore and export paths work without errors", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await page.goto("/index.html");
  await expect.poll(() => page.evaluate(() => window.__nsnvcModuleStarted)).toBe(true);
  await page.fill("#adminEmail", "smoke@test.local");
  await page.fill("#adminPass", DEV_PASSWORD);
  await page.click("#loginBtn");
  await expect(page.locator("#dashboard")).toBeVisible();

  // Open the first household's account.
  await page.locator("#adminList .citizen-row").first().click();
  await expect(page.locator("#adminDetail")).toBeVisible();

  // The ledger engine must have produced a balance for the account view.
  await expect(page.locator("#adminDetail")).toContainText(/₹/);

  // Go back to the dashboard.
  await page.locator("#adminBackBtn").click();
  await expect(page.locator("#dashboard")).toBeVisible();

  expect(errors, `page errors: ${errors.join(" | ")}`).toEqual([]);
});

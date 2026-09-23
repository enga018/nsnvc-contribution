// Browser smoke test.
//
// This is the only check that actually *executes* the app, so it catches
// runtime wiring errors (e.g. a global read before its declaration in the
// temporal dead zone) that `node --check` and the unit tests cannot.
//
// It runs index.html in local test mode — no Firebase, no network — by serving
// the repo over a local static server and logging in with the dev password.
import { test, expect } from "@playwright/test";

const DEV_PASSWORD = "dev-mode-only";

// Waits until the module has started and the store is ready, then logs in and
// waits for the dashboard. Clicking before the store exists is a no-op (the
// login button is bound early by design), so we gate on the readiness flag.
async function login(page) {
  // Force local test mode so we never touch the real Firebase project: this
  // sets the flag before any page script runs (addInitScript runs first).
  await page.addInitScript(() => { window.__nsnvcForceLocalMode = true; });

  await page.goto("/index.html");
  await expect.poll(() => page.evaluate(() => window.__nsnvcModuleStarted), {
    message: "module did not start",
    timeout: 10_000
  }).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__nsnvcStoreReady), {
    message: "store never became ready",
    timeout: 10_000
  }).toBe(true);

  await page.fill("#adminEmail", "smoke@test.local");
  await page.fill("#adminPass", DEV_PASSWORD);
  await page.click("#loginBtn");

  try {
    await expect(page.locator("#dashboard")).toBeVisible({ timeout: 10_000 });
  } catch (err) {
    // Surface why login didn't complete, so a CI failure is actionable
    // instead of just "dashboard stayed hidden".
    const loginErr = await page.locator("#loginErr").innerText().catch(() => "<none>");
    throw new Error(`dashboard never became visible. #loginErr="${loginErr}". ${err.message}`);
  }
}

function collectErrors(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  return errors;
}

// The app normally runs against Firebase. CI has no Firebase credentials (and
// may have no network to load the SDK), so this test does NOT assert on console
// output — the app legitimately logs "Firebase initialization failed" and falls
// back to local mode. Instead it asserts the module reached its final statement
// (window.__nsnvcBootComplete), which only happens if no top-level statement
// threw. That is exactly the class of bug (storeHost/markSyncing) this guards.
test("boots on the real (Firebase) path without a startup crash", async ({ page }) => {
  // NOTE: deliberately do NOT set __nsnvcForceLocalMode here.
  await page.goto("/index.html");

  await expect.poll(() => page.evaluate(() => window.__nsnvcModuleStarted), {
    message: "module did not start",
    timeout: 15_000
  }).toBe(true);

  // Reached only if every top-level statement ran without throwing.
  await expect.poll(() => page.evaluate(() => window.__nsnvcBootComplete), {
    message: "module did not reach its final statement — startup threw",
    timeout: 25_000
  }).toBe(true);

  // And the store exists (Firebase or local fallback).
  await expect.poll(() => page.evaluate(() => window.__nsnvcStoreReady), {
    message: "store never became ready",
    timeout: 10_000
  }).toBe(true);
});

test("app boots, logs in, and renders the dashboard", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);

  // Local test mode seeds sample households, so the list must not be empty.
  await expect(page.locator("#adminList .citizen-row").first()).toBeVisible({ timeout: 10_000 });

  // No uncaught runtime errors along the way (this is what caught the
  // syncPendingWrites temporal-dead-zone crash).
  expect(errors, `page errors: ${errors.join(" | ")}`).toEqual([]);
});

test("opening a household account works without errors", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);

  // Open the first household's account.
  await page.locator("#adminList .citizen-row").first().click();
  await expect(page.locator("#adminDetail")).toBeVisible({ timeout: 10_000 });

  // The ledger engine must have produced a balance for the account view.
  await expect(page.locator("#adminDetail")).toContainText(/₹/);

  // Back to the dashboard.
  await page.locator("#adminBackBtn").click();
  await expect(page.locator("#dashboard")).toBeVisible({ timeout: 10_000 });

  expect(errors, `page errors: ${errors.join(" | ")}`).toEqual([]);
});

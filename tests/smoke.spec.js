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

// The app normally runs against Firebase. We can't log into the real project
// from CI, but we CAN boot the real (non-local) code path and assert the module
// survives startup — which is exactly where the syncPendingWrites temporal-dead
// -zone crash happened. Requires network access to load the Firebase SDK; if
// that fails the app falls back to local mode, so we only assert "no crash".
test("boots in Firebase mode without a startup crash", async ({ page }) => {
  const errors = collectErrors(page);
  // NOTE: deliberately do NOT set __nsnvcForceLocalMode here.
  await page.goto("/index.html");

  await expect.poll(() => page.evaluate(() => window.__nsnvcModuleStarted), {
    message: "module did not start",
    timeout: 15_000
  }).toBe(true);

  // The store is created on both paths (Firebase or local fallback); if a
  // startup wiring error aborted the module, this never becomes true.
  await expect.poll(() => page.evaluate(() => window.__nsnvcStoreReady), {
    message: "store never became ready — startup likely threw",
    timeout: 20_000
  }).toBe(true);

  expect(errors, `page errors: ${errors.join(" | ")}`).toEqual([]);
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

import { defineConfig } from "@playwright/test";

// Serves the repo root so index.html + ledger.js load over http (ES modules
// and service workers need http(s), not file://). No build step.
export default defineConfig({
  testDir: "./tests",
  testMatch: /.*\.spec\.js/,
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:8092",
    // The app's dashboard uses IndexedDB (Firestore cache) — a fresh context
    // per test keeps runs isolated.
    serviceWorkers: "allow"
  },
  webServer: {
    command: "node scripts/serve-for-tests.mjs",
    url: "http://127.0.0.1:8092/index.html",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  },
  reporter: process.env.CI ? "github" : "list"
});

import { existsSync } from "node:fs";

import { defineConfig, devices } from "@playwright/test";

const configuredBrowser = process.env.QUIETPACT_BROWSER_PATH;
const systemChrome = "/usr/bin/google-chrome";
const localBrowserPath =
  configuredBrowser ?? (!process.env.CI && existsSync(systemChrome) ? systemChrome : undefined);
const localBrowser = localBrowserPath === undefined ? {} : { executablePath: localBrowserPath };

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      ...localBrowser,
      args: ["--no-sandbox"],
    },
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"] },
    },
  ],
  webServer: [
    {
      command: "node tests/browser/support/start-stack.mjs",
      url: "http://127.0.0.1:13001/health",
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command:
        "QUIETPACT_API_PROXY_TARGET=http://127.0.0.1:13001 VITE_QUIETPACT_RPC_URL=http://127.0.0.1:18545 pnpm --filter @quietpact/web dev --host 127.0.0.1 --port 4173",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});

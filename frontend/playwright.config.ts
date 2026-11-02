import { defineConfig } from "@playwright/test";

/** Browser tests against the real voice engine (see e2e/voice.spec.ts). Run: npm run test:e2e */
export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts", // generates the spoken test lines with the running engine
  timeout: 240_000,
  workers: 1, // the engine runs one session at a time
  reporter: "list",
  use: {
    channel: "chrome", // the installed Google Chrome; nothing is downloaded
    baseURL: "http://localhost:3000",
  },
  webServer: {
    command: "npm run build && npm run start",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 180_000,
  },
});

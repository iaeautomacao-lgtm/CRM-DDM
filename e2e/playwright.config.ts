import { defineConfig, devices } from "@playwright/test";

import { baseUrl, selectedRoles } from "./roles";

// Alvo e credenciais por variável de ambiente (ver docs/e2e-telas.md). Sempre rode da raiz do repositório:
//   npm run e2e:telas
const base = baseUrl();
selectedRoles(); // valida E2E_ROLES cedo

export default defineConfig({
  testDir: ".",
  testMatch: ["auth.setup.ts", "telas.spec.ts"],
  outputDir: "e2e/test-results",
  fullyParallel: true,
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : 4,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  reporter: [["list"], ["html", { outputFolder: "e2e/report", open: "never" }]],
  use: {
    baseURL: base,
    locale: "pt-BR",
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "setup", testMatch: "auth.setup.ts", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    {
      name: "telas",
      testMatch: "telas.spec.ts",
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
});

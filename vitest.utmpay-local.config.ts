import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Teste de integração LOCAL UTMpay ↔ CRM (npm run test:utmpay-local). Config própria: o vitest padrão (e o CI dos PRs) só pega `src/**/*.test.ts`,
// então este teste, que sobe um processo Python, nunca roda lá. Veja docs/utmpay.md ("Teste local").
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: { "server-only": fileURLToPath(new URL("./src/test/server-only-empty.ts", import.meta.url)) },
  },
  test: {
    include: ["scripts/utmpay-local/**/*.e2e.ts"],
    environment: "node",
    hookTimeout: 120_000,
    testTimeout: 120_000,
    fileParallelism: false,
    env: {
      ENCRYPTION_KEY: "0000000000000000000000000000000000000000000000000000000000000000",
      META_APP_SECRET: "test-meta-app-secret",
    },
  },
});

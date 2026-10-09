import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    // `import "server-only"` lança fora de um bundle de servidor do Next (é o que faz o build falhar para client components); nos
    // testes (Node) o módulo vira vazio. PRD 14, 14.12.
    alias: {
      "server-only": fileURLToPath(new URL("./src/test/server-only-empty.ts", import.meta.url)),
    },
  },
  test: {
    // PGlite sobe um Postgres inteiro no beforeAll: com a máquina carregada (CI, vários agentes)
    // os 10 s padrão estouram. Só afeta hooks; o timeout de cada teste segue o padrão.
    hookTimeout: 60_000,
    // Idem para testes que geram muitos dados ou sobem servidores simulados: 5 s estourava sob carga
    // (cron do disparador, exportação retomável, varredura de src). Teste lento de verdade continua visível.
    testTimeout: 20_000,
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Dummy secrets — encryption.ts / webhook-signature.ts read these
    // at module load. Tests never hit a real Meta/Supabase service, so
    // any 32-byte hex / non-empty string will do; keep them lexically
    // identical to the CI build env so behaviour matches.
    env: {
      ENCRYPTION_KEY:
        "0000000000000000000000000000000000000000000000000000000000000000",
      META_APP_SECRET: "test-meta-app-secret",
    },
    clearMocks: true,
  },
});

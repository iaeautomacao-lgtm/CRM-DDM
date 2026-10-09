import { readFileSync } from "node:fs";
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// PRD 14, 14.12 — módulos só de servidor: a MESMA lista do client-scan e do `import "server-only"` (scripts/ci/server-only-modules.json).
// O `server-only` faz o BUILD falhar quando um client component alcança o módulo; esta regra pega antes, no editor/lint, nos
// diretórios que são sempre cliente (clientOnlyDirs), inclusive imports relativos.
const serverOnly = JSON.parse(readFileSync(new URL("./scripts/ci/server-only-modules.json", import.meta.url), "utf8"));
const serverOnlyPatterns = serverOnly.modules.map((file) => {
  const withoutSrc = file.replace(/^src\//, "").replace(/\.tsx?$/, "");
  return {
    group: ["@/" + withoutSrc, "**/" + withoutSrc],
    message: "Módulo só de servidor (scripts/ci/server-only-modules.json): não importe de componente/hook de cliente. Chame uma rota de API ou um server component.",
  };
});

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored minified opus-recorder encoder worker (served statically).
    "public/opus/**",
    // Separate NestJS app with its own package.json/tsconfig — not part of this Next.js lint scope.
    "disparador/**",
    // Passenger entry point (CommonJS — committed by server setup).
    "app.js",
  ]),
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    files: serverOnly.clientOnlyDirs.map((dir) => `${dir}/**/*.{ts,tsx}`),
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: serverOnlyPatterns }],
    },
  },
]);

export default eslintConfig;
// Gera o bundle único do worker de envio: dist/dispatch-worker.cjs (dependências embutidas; roda com só Node 20 + env).
// Uso: npm run build:worker   (build na máquina de dev; o deploy é copiar o arquivo — ops/ e scripts/deploy-worker.sh são MODELOS).
import { build } from "esbuild";
import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = resolve(root, process.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? "dist/dispatch-worker.cjs");

await build({
  entryPoints: [resolve(root, "src/worker/main.ts")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: "linked",
  logLevel: "warning",
  alias: {
    "@": resolve(root, "src"),
    "server-only": resolve(root, "src/test/server-only-empty.ts"),
    "next/headers": resolve(root, "src/worker/stubs/next-headers.ts"),
  },
  define: { "process.env.NODE_ENV": '"production"' },
});

console.log(`worker: ${outfile} (${(statSync(outfile).size / 1024 / 1024).toFixed(2)} MB)`);

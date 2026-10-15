import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const dir = mkdtempSync(join(tmpdir(), "farol-worker-bundle-"));
const out = join(dir, "dispatch-worker.cjs");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("bundle do worker de envio (scripts/build-worker.mjs)", () => {
  it("gera um arquivo único, sem o Next embutido, que carrega e responde ao --check sem env nem banco", () => {
    execFileSync(process.execPath, [join(root, "scripts/build-worker.mjs"), `--out=${out}`], { cwd: root, stdio: "pipe" });
    const size = statSync(out).size;
    expect(size).toBeGreaterThan(200_000);
    expect(size).toBeLessThan(8 * 1024 * 1024);
    const code = readFileSync(out, "utf8");
    expect(code).not.toContain("next/dist");
    const env = ({ PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" } as unknown as NodeJS.ProcessEnv);
    expect(execFileSync(process.execPath, [out, "--check"], { env, encoding: "utf8" })).toContain("ok");
  }, 60_000);

  it("sem as variáveis obrigatórias, sai com código 2 e diz quais faltam", () => {
    const env = ({ PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" } as unknown as NodeJS.ProcessEnv);
    try {
      execFileSync(process.execPath, [out], { env, encoding: "utf8", stdio: "pipe" });
      throw new Error("deveria falhar");
    } catch (error) {
      const e = error as { status?: number; stderr?: string };
      expect(e.status).toBe(2);
      expect(e.stderr).toContain("SUPABASE_SERVICE_ROLE_KEY");
    }
  }, 30_000);
});

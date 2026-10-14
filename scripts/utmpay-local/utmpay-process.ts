// Sobe e derruba o UTMpay (Flask) para o teste local, em modo ARQUIVO (sem MYSQL_*), com Python portátil.
// O app é carregado por `python -c`, com o diretório do app no sys.path, e rodado com o servidor de desenvolvimento do Flask.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_PYTHON = "C:/Users/Arthur.Henriques/py312/python.exe";
export const DEFAULT_UTMPAY_DIR = "C:/Users/Arthur.Henriques/utmpay-v2";

export function localSetup(env: NodeJS.ProcessEnv = process.env): { python: string; dir: string; missing: string[] } {
  const python = env.UTMPAY_PYTHON ?? DEFAULT_PYTHON;
  const dir = env.UTMPAY_DIR ?? DEFAULT_UTMPAY_DIR;
  const missing: string[] = [];
  if (!existsSync(python)) missing.push(`Python (UTMPAY_PYTHON): ${python}`);
  if (!existsSync(join(dir, "app.py"))) missing.push(`UTMpay (UTMPAY_DIR): ${dir}`);
  return { python, dir, missing };
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

export interface RunningUtmpay {
  baseUrl: string;
  dataDir: string;
  logs: () => string;
  stop: () => Promise<void>;
}

export interface UtmpayOptions {
  python: string;
  dir: string;
  port: number;
  apiKey: string;
  crmEventsUrl: string;
  crmEventsSecret: string;
  /** Domínios aceitos em url_destino (UTM_DESTINOS_PERMITIDOS). */
  destinos?: string;
}

async function waitHealthy(baseUrl: string, child: ChildProcess, logs: () => string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`UTMpay saiu antes de subir (código ${child.exitCode}):\n${logs()}`);
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return;
    } catch {
      // ainda subindo
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`UTMpay não respondeu em ${timeoutMs} ms:\n${logs()}`);
}

export async function startUtmpay(opts: UtmpayOptions): Promise<RunningUtmpay> {
  const dataDir = mkdtempSync(join(tmpdir(), "utmpay-local-"));
  const baseUrl = `http://127.0.0.1:${opts.port}`;
  const code = [
    "import sys",
    `sys.path.insert(0, ${JSON.stringify(opts.dir)})`,
    "from app import app",
    `app.run(host='127.0.0.1', port=${opts.port}, threaded=True, use_reloader=False)`,
  ].join("; ");

  // Ambiente limpo de MYSQL_*: o UTMpay cai no modo arquivo (DDMPAY_DATA_DIR temporário).
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("MYSQL_")) delete env[key];
  Object.assign(env, {
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
    DDMPAY_DATA_DIR: dataDir,
    UTM_API_KEY: opts.apiKey,
    CRM_EVENTS_URL: opts.crmEventsUrl,
    CRM_EVENTS_SECRET: opts.crmEventsSecret,
    CRM_EVENTS_TIMEOUT: "5",
    UTM_FUNIL_LIMITE_POR_MIN: "600",
    ...(opts.destinos ? { UTM_DESTINOS_PERMITIDOS: opts.destinos } : {}),
  });

  const child = spawn(opts.python, ["-c", code], { env, cwd: dataDir, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "";
  const collect = (chunk: Buffer) => {
    output += chunk.toString("utf8");
    if (output.length > 200_000) output = output.slice(-100_000);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const logs = () => output;

  const stop = async () => {
    if (child.exitCode === null) {
      child.kill();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // arquivo ainda preso no Windows: é temporário, o SO limpa
    }
  };

  try {
    await waitHealthy(baseUrl, child, logs);
  } catch (err) {
    await stop();
    throw err;
  }
  return { baseUrl, dataDir, logs, stop };
}

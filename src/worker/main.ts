// Ponto de entrada do worker de envio (bundle: scripts/build-worker.mjs → dist/dispatch-worker.cjs).
//
//   node dist/dispatch-worker.cjs            → sobe o worker (precisa das variáveis abaixo)
//   node dist/dispatch-worker.cjs --check    → carrega o bundle e sai 0, sem env nem banco (teste de fumaça do deploy)
//
// Variáveis obrigatórias: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ENCRYPTION_KEY (opção A de segredos do PRD 12: só no piloto).
// Opcionais: DISPATCH_WORKER_GROUP, DISPATCH_WORKER_MAX_NUMBERS (2), DISPATCH_WORKER_ID, DISPATCH_WORKER_DRAIN_MS (8000).
import { assertLoadTestGate } from "@/lib/loadtest/gate";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { DispatchWorker, MigrationRequiredError, WORKER_VERSION } from "./dispatch-worker";
import { formatWorkerEvent } from "./log";

const REQUIRED_ENV = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ENCRYPTION_KEY"] as const;
/** Limite duro: se a parada limpa não terminar, o processo sai mesmo assim (o systemd também mata em TimeoutStopSec). */
const HARD_EXIT_MS = 15_000;

// supabase-js (realtime) procura um WebSocket global; o Node 20 não tem. O worker não usa realtime: um stub inerte basta.
function ensureWebSocketStub(): void {
  const g = globalThis as unknown as { WebSocket?: unknown };
  if (typeof g.WebSocket !== "undefined") return;
  g.WebSocket = class UnavailableWebSocket {
    constructor() {
      throw new Error("WebSocket indisponível no worker de envio");
    }
  };
}

export function missingEnv(env: Record<string, string | undefined>): string[] {
  return REQUIRED_ENV.filter((name) => !(env[name] ?? "").trim());
}

async function start(): Promise<void> {
  const missing = missingEnv(process.env);
  if (missing.length > 0) {
    console.error(`[worker] variáveis ausentes: ${missing.join(", ")}`);
    process.exit(2);
  }
  assertLoadTestGate(process.env);
  ensureWebSocketStub();

  const worker = new DispatchWorker({ db: supabaseAdmin() });
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(formatWorkerEvent("dispatch_worker_signal", { signal }));
    const hard = setTimeout(() => process.exit(1), HARD_EXIT_MS);
    hard.unref();
    void worker.stop().finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  try {
    await worker.run();
  } catch (error) {
    // Migration ausente: erro de configuração, o operador precisa agir (Restart=always reinicia, mas o log explica).
    console.error(`[worker] ${error instanceof Error ? error.message : String(error)}`);
    await worker.stop();
    process.exit(error instanceof MigrationRequiredError ? 3 : 1);
  }
}

if (process.argv.includes("--check")) {
  console.log(`dispatch-worker ${WORKER_VERSION} ok`);
  process.exit(0);
} else {
  void start();
}

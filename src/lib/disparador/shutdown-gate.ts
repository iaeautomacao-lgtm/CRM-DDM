// Desligamento gracioso dos envios (AUDIT-DISPARADOR D-02). No SIGTERM (deploy/restart do Passenger):
//   1) para de INICIAR chamadas ao provedor (o processQueue consulta isShuttingDown() antes de gravar o marcador e devolve o item à fila);
//   2) espera os envios já em voo, até SHUTDOWN_WAIT_MS (padrão 8 s), para que a confirmação local seja gravada;
//   3) só então os micro-lotes de confirmação são drenados (confirm-batcher.ts, registerShutdownDrain).
// Não muda ritmo, limite nem timeout de envio: só o que acontece quando o processo recebe o aviso de saída. O handler só é instalado
// quando há envio em voo e nunca chama process.exit (o Passenger encerra o processo).

export const SHUTDOWN_WAIT_MS = 8_000;

let shuttingDown = false;
const inFlight = new Set<Promise<unknown>>();
let handlerInstalled = false;
const afterWait: Array<() => Promise<void>> = [];

export function isShuttingDown(): boolean {
  return shuttingDown;
}

/** Só para testes. */
export function resetShutdownGate(): void {
  shuttingDown = false;
  inFlight.clear();
  afterWait.length = 0;
}

/** Espera os envios em voo (nunca rejeita) até o teto. Devolve quantos ainda estavam pendentes ao fim. */
export async function waitForInFlightSends(timeoutMs: number = SHUTDOWN_WAIT_MS): Promise<number> {
  if (inFlight.size === 0) return 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled([...inFlight]),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  return inFlight.size;
}

/** Marca o início do desligamento e executa a espera e os callbacks registrados (drenagem de confirmações). */
export async function beginShutdown(timeoutMs: number = SHUTDOWN_WAIT_MS): Promise<void> {
  shuttingDown = true;
  await waitForInFlightSends(timeoutMs);
  await Promise.allSettled(afterWait.map((fn) => fn()));
}

/** Registra algo a rodar DEPOIS da espera dos envios em voo (ex.: drenar os micro-lotes de confirmação). Devolve o cancelamento. */
export function onShutdownAfterSends(fn: () => Promise<void>): () => void {
  afterWait.push(fn);
  installHandler();
  return () => {
    const i = afterWait.indexOf(fn);
    if (i >= 0) afterWait.splice(i, 1);
  };
}

function installHandler(): void {
  if (handlerInstalled || typeof process === "undefined" || typeof process.on !== "function") return;
  handlerInstalled = true;
  process.on("SIGTERM", () => {
    void beginShutdown();
  });
}

/**
 * Registra um envio em voo (do claim até a confirmação). Instala o handler de SIGTERM na primeira vez. Devolve a mesma promise
 * (rejeição inclusive): quem chama continua tratando o erro como antes.
 */
export function trackSend<T>(promise: Promise<T>): Promise<T> {
  installHandler();
  inFlight.add(promise);
  const done = () => void inFlight.delete(promise);
  promise.then(done, done);
  return promise;
}

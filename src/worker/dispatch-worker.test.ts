import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/disparador/auto-pause", async (orig) => ({
  ...(await orig<typeof import("@/lib/disparador/auto-pause")>()),
  checkCampaignAutoPause: vi.fn(async () => false),
}));

import { DispatchWorker, MigrationRequiredError, resolveWorkerConfig, type WorkerConfig } from "./dispatch-worker";
import { resetShutdownGate } from "@/lib/disparador/shutdown-gate";

type Rows = Record<string, unknown[]>;
type RpcHandler = (args: Record<string, unknown>) => { data?: unknown; error?: { code?: string; message: string } | null };

function fakeDb(tables: Rows, rpcs: Record<string, RpcHandler>) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "limit", "neq"]) b[m] = () => b;
    b.then = (resolve: (v: unknown) => unknown) => resolve({ data: tables[table] ?? [], error: null });
    return b;
  };
  const db = {
    from: (table: string) => builder(table),
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      calls.push({ fn, args });
      const handler = rpcs[fn];
      if (!handler) return { data: null, error: { code: "PGRST202", message: `sem handler ${fn}` } };
      const r = handler(args);
      return { data: r.data ?? null, error: r.error ?? null };
    },
  };
  return { db: db as never, calls };
}

const baseTables = (): Rows => ({
  dispatch_channel_ownership: [
    { session_id: "s1", worker_group: null },
    { session_id: "s2", worker_group: "g2" },
    { session_id: "s3", worker_group: null },
  ],
  whatsapp_config: [
    { id: "s1", provider: "meta", habilitado: true },
    { id: "s2", provider: "meta", habilitado: true },
    { id: "s3", provider: "waha", habilitado: true },
  ],
  campaigns: [{ id: "c1", account_id: "a1", status: "em_execucao", batch_size: 50, janela_inicio: null, janela_fim: null, dias_envio: null, session_ids: null }],
});

let clock = 1_000_000;
const advance = (ms: number) => (clock += ms);

function makeWorker(opts: { tables?: Rows; rpcs?: Record<string, RpcHandler>; env?: Record<string, string>; config?: Partial<WorkerConfig>; sendStage?: ReturnType<typeof vi.fn> }) {
  const { db, calls } = fakeDb(opts.tables ?? baseTables(), {
    live_worker_sessions: () => ({ data: [] }),
    acquire_dispatch_leases: (a) => ({ data: a.p_session_ids }),
    renew_dispatch_leases: (a) => ({ data: a.p_session_ids }),
    release_dispatch_leases: () => ({ data: 1 }),
    count_due_dispatch_items: () => ({ data: [{ campaign_id: "c1", session_id: "s1", n: 3 }, { campaign_id: "c1", session_id: "s9", n: 2 }] }),
    ...opts.rpcs,
  });
  const logs: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const sendStage =
    opts.sendStage ??
    vi.fn(async () => ({ globalPeakInFlight: 4, channels: [] }));
  const config = { ...resolveWorkerConfig({ DISPATCH_WORKER_ID: "w-test" }), ...opts.config };
  const worker = new DispatchWorker({
    db,
    env: { DISPATCH_WORKER_ENABLED: "1", ...opts.env },
    config,
    now: () => clock,
    sleep: async () => undefined,
    log: (event, payload) => logs.push({ event, payload }),
    sendStage: sendStage as never,
    heartbeat: async () => undefined,
    writeTick: async () => undefined,
  });
  return { worker, calls, logs, sendStage };
}

beforeEach(() => {
  resetShutdownGate();
  advance(60_000); // invalida o cache de chaves entre testes
});

describe('resolveWorkerConfig', () => {
  it('padrões: 2 números, drain 8 s, id próprio quando não informado', () => {
    const c = resolveWorkerConfig({});
    expect(c.maxNumbers).toBe(2);
    expect(c.drainMs).toBe(8000);
    expect(c.group).toBeNull();
    expect(c.owner).toMatch(/:/);
  });
  it('lê grupo/teto/id e limita valores absurdos', () => {
    const c = resolveWorkerConfig({ DISPATCH_WORKER_GROUP: " g2 ", DISPATCH_WORKER_MAX_NUMBERS: "99", DISPATCH_WORKER_ID: "w9", DISPATCH_WORKER_DRAIN_MS: "1" });
    expect(c).toMatchObject({ group: "g2", maxNumbers: 10, owner: "w9", drainMs: 1000 });
  });
});

describe('DispatchWorker.round', () => {
  it('chave desligada: fica ocioso, não adquire nada e não envia', async () => {
    const { worker, calls, sendStage } = makeWorker({ env: { DISPATCH_WORKER_ENABLED: "0" } });
    const r = await worker.round();
    expect(r).toMatchObject({ worked: false, reason: "flag_off" });
    expect(calls.find((c) => c.fn === "acquire_dispatch_leases")).toBeUndefined();
    expect(sendStage).not.toHaveBeenCalled();
  });

  it('chave desligada depois de ligada: libera os leases', async () => {
    const { worker, calls } = makeWorker({});
    await worker.round();
    expect(worker.ownedSessions()).toEqual(["s1"]);
    (worker as unknown as { env: Record<string, string> }).env = { DISPATCH_WORKER_ENABLED: "0" };
    advance(60_000);
    const r = await worker.round();
    expect(r.reason).toBe("flag_off");
    expect(worker.ownedSessions()).toEqual([]);
    expect(calls.some((c) => c.fn === "release_dispatch_leases")).toBe(true);
  });

  it('adquire só número Meta habilitado, sem grupo ou do próprio grupo, e envia só os itens dos números próprios', async () => {
    const { worker, calls, sendStage } = makeWorker({ config: { group: null } });
    const r = await worker.round();
    const acquire = calls.find((c) => c.fn === "acquire_dispatch_leases")!;
    expect(acquire.args).toMatchObject({ p_owner: "w-test", p_session_ids: ["s1"] }); // s2 é do grupo g2, s3 é WAHA
    expect(r.worked).toBe(true);
    const input = sendStage.mock.calls[0][0] as { planned: Array<{ items: Array<{ session_id: string }> }>; batchMode: boolean; claimerRated: { owner: string } };
    expect(input.batchMode).toBe(true);
    expect(input.claimerRated.owner).toBe("w-test");
    expect(input.planned[0].items).toHaveLength(3);
    expect(input.planned[0].items.every((i) => i.session_id === "s1")).toBe(true);
  });

  it('respeita o teto de números e o grupo', async () => {
    const t = baseTables();
    (t.dispatch_channel_ownership as Array<{ session_id: string; worker_group: string | null }>).push({ session_id: "s4", worker_group: "g2" });
    (t.whatsapp_config as unknown[]).push({ id: "s4", provider: "meta", habilitado: true });
    const { worker } = makeWorker({ tables: t, config: { group: "g2", maxNumbers: 2 } });
    await worker.round();
    expect(worker.ownedSessions()).toEqual(["s1", "s2"]);
  });

  it('não pega número que outro worker vivo já tem', async () => {
    const { worker, calls } = makeWorker({ rpcs: { live_worker_sessions: () => ({ data: ["s1"] }) } });
    const r = await worker.round();
    expect(calls.find((c) => c.fn === "acquire_dispatch_leases")).toBeUndefined();
    expect(r.reason).toBe("no_numbers");
  });

  it('campanha sequencial (batch_size 1) fica com o cron', async () => {
    const t = baseTables();
    (t.campaigns as Array<{ batch_size: number }>)[0].batch_size = 1;
    const { worker, sendStage } = makeWorker({ tables: t });
    const r = await worker.round();
    expect(r.reason).toBe("nothing_due");
    expect(sendStage).not.toHaveBeenCalled();
  });

  it('perda de lease na renovação: para de enviar aquele número e registra', async () => {
    const { worker, logs } = makeWorker({ rpcs: { renew_dispatch_leases: () => ({ data: [] }) } });
    await worker.round();
    expect(worker.ownedSessions()).toEqual(["s1"]);
    advance(11_000);
    await worker.round(); // renova → perdeu s1 → readquire (acquire devolve livre) ; o evento de perda fica no log
    expect(logs.some((l) => l.event === "dispatch_worker_lease_lost" && l.payload.session_id === "s1")).toBe(true);
  });

  it('claim not_owner (onLostOwnership) tira o número do conjunto próprio', async () => {
    const sendStage = vi.fn(async (input: { claimerRated: { onLostOwnership: (id: string) => void } }) => {
      input.claimerRated.onLostOwnership("s1");
      return { globalPeakInFlight: 0, channels: [] };
    });
    const { worker, logs } = makeWorker({ sendStage: sendStage as never });
    await worker.round();
    expect(worker.ownedSessions()).toEqual([]);
    expect(logs.some((l) => l.event === "dispatch_worker_lease_lost")).toBe(true);
  });

  it('migration 367 ausente: erro explícito para o operador', async () => {
    const { worker } = makeWorker({ rpcs: { acquire_dispatch_leases: () => ({ error: { code: "PGRST202", message: "x" } }) } });
    await expect(worker.round()).rejects.toBeInstanceOf(MigrationRequiredError);
  });
});

describe('DispatchWorker.stop (SIGTERM)', () => {
  it('para de iniciar, expira os leases e registra o desligamento; segunda chamada não repete', async () => {
    const { worker, calls, logs } = makeWorker({});
    await worker.round();
    await worker.stop();
    await worker.stop();
    expect(calls.filter((c) => c.fn === "release_dispatch_leases")).toHaveLength(1);
    expect(logs.map((l) => l.event)).toContain("dispatch_worker_shutdown");
    expect(worker.isStopping()).toBe(true);
    expect((await worker.round()).reason).toBe("stopping");
  });

  it('outOfTime passado ao estágio reflete a parada', async () => {
    let outOfTime: (() => boolean) | undefined;
    const sendStage = vi.fn(async (input: { outOfTime: () => boolean }) => {
      outOfTime = input.outOfTime;
      return { globalPeakInFlight: 0, channels: [] };
    });
    const { worker } = makeWorker({ sendStage: sendStage as never });
    await worker.round();
    expect(outOfTime!()).toBe(false);
    await worker.stop();
    expect(outOfTime!()).toBe(true);
  });
});

describe('DispatchWorker.round — sem barreira entre números nem entre rodadas', () => {
  const twoNumbers = () => {
    const t = baseTables();
    (t.dispatch_channel_ownership as Array<{ session_id: string; worker_group: string | null }>).push({ session_id: "s5", worker_group: null });
    (t.whatsapp_config as unknown[]).push({ id: "s5", provider: "meta", habilitado: true });
    return t;
  };
  const due = () => ({ data: [{ campaign_id: "c1", session_id: "s1", n: 3 }, { campaign_id: "c1", session_id: "s5", n: 3 }] });
  const sessionOf = (input: unknown) => (input as { planned: Array<{ items: Array<{ session_id: string }> }> }).planned[0].items[0].session_id;

  it('um envio preso (timeout da Meta) em UM número não segura a rodada nem o outro número', async () => {
    let release: () => void = () => undefined;
    const stuck = new Promise<void>((resolve) => (release = resolve));
    const started: string[] = [];
    const sendStage = vi.fn(async (input: unknown) => {
      const id = sessionOf(input);
      started.push(id);
      if (id === "s1") await stuck; // o envio em voo de s1 só termina no timeout (10 s na Meta real)
      return { globalPeakInFlight: 1, channels: [] };
    });
    const { worker } = makeWorker({ tables: twoNumbers(), rpcs: { count_due_dispatch_items: due }, sendStage: sendStage as never, config: { maxNumbers: 2, roundBudgetMs: 20 } });

    const first = await Promise.race([worker.round(), new Promise<"travou">((r) => setTimeout(() => r("travou"), 2_000))]);
    expect(first).not.toBe("travou"); // a rodada fecha no orçamento de início, sem esperar o envio preso
    expect(started.sort()).toEqual(["s1", "s5"]);

    // A rodada seguinte replaneja: s5 volta a enviar enquanto a cauda de s1 ainda está em voo.
    advance(1_000);
    const second = await Promise.race([worker.round(), new Promise<"travou">((r) => setTimeout(() => r("travou"), 2_000))]);
    expect(second).not.toBe("travou");
    expect(started.filter((id) => id === "s5").length).toBeGreaterThanOrEqual(2);

    release();
    await worker.stop();
  });

  it('a cauda em voo conta nos envios quando termina e o erro de um número não derruba os outros', async () => {
    const sendStage = vi.fn(async (input: unknown) => {
      if (sessionOf(input) === "s1") throw new Error("falha só do s1");
      return { globalPeakInFlight: 1, channels: [] };
    });
    const { worker, logs } = makeWorker({ tables: twoNumbers(), rpcs: { count_due_dispatch_items: due }, sendStage: sendStage as never, config: { maxNumbers: 2 } });
    const r = await worker.round();
    expect(r.worked).toBe(true);
    expect(sendStage).toHaveBeenCalledTimes(2);
    expect(logs.some((l) => l.event === "dispatch_worker_number_error" && l.payload.session_id === "s1")).toBe(true);
  });
});

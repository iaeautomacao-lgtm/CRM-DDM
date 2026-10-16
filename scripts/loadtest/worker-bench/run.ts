// Bancada LOCAL do worker de envio (W4): N números × taxa, Meta simulada, Postgres portátil (PGlite). Sem Supabase, sem staging, sem mensagem real.
//
//   npm run bench:worker                       # 20 números × 80/s, 5 processos, 60 s medidos
//   BENCH_NUMBERS=4 BENCH_WORKERS=1 npm run bench:worker
//
// Variáveis (todas opcionais): BENCH_NUMBERS=20 · BENCH_WORKERS=5 (processos; DISPATCH_WORKER_MAX_NUMBERS real = 2, teto global 400 vagas) ·
// BENCH_RATE=80 (envios/s por número) · BENCH_DURATION_S=60 · BENCH_WARMUP_S=10 · BENCH_ROUND_MS=20000 (DISPATCH_WORKER_ROUND_MS) ·
// BENCH_LATENCY_P50_MS=850 · BENCH_LATENCY_P95_MS=1000 · BENCH_ERRORS="5xx=0.01,429=0.005,131056=0.002,async_131026=0.003,timeout=0.005" ("none" = sem falha) ·
// BENCH_DB=pglite|memory (pglite = SQL real, 1 conexão, mais lento que Postgres nativo; memory = RPCs em JS, isola a CPU do worker) ·
// BENCH_QUIET_PCT / BENCH_PRIORITY=above (ver abaixo, máquina compartilhada) · BENCH_SLOW_NUMBERS=0 (quantos números têm latência 3 s: prova que um número lento não segura os outros) · BENCH_OUT=dist/worker-bench.
// Nunca liga DISPARADOR_BATCH_CLAIM nem DISPARADOR_TICK_CHAIN: o ambiente dos workers é montado do zero, sem herdar o do shell.
import { spawn, fork, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cpus, constants as osConstants, setPriority } from "node:os";
import { BenchDb } from "./db-client";
import type { WorkerBenchConfig, WorkerBenchResult } from "./worker-proc";
import { capacityPerCore, coresUsed, fairness, fixed, numberRate, percentile, sum, windowOf } from "@/worker/bench-stats";

const root = process.cwd();
const dir = resolve(root, "scripts/loadtest/worker-bench");
const num = (name: string, def: number, min: number, max: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && process.env[name] !== undefined && process.env[name] !== "" ? Math.min(max, Math.max(min, n)) : def;
};

const NUMBERS = Math.floor(num("BENCH_NUMBERS", 20, 1, 60));
const WORKERS = Math.floor(num("BENCH_WORKERS", Math.ceil(NUMBERS / 4), 1, NUMBERS));
const RATE = num("BENCH_RATE", 80, 1, 200);
const DURATION_S = Math.floor(num("BENCH_DURATION_S", 60, 5, 1800));
const WARMUP_S = Math.floor(num("BENCH_WARMUP_S", 10, 0, 120));
const ROUND_MS = Math.floor(num("BENCH_ROUND_MS", 20_000, 2_000, 50_000));
const P50 = num("BENCH_LATENCY_P50_MS", 850, 1, 10_000);
const P95 = num("BENCH_LATENCY_P95_MS", 1000, 1, 10_000);
const SLOW = Math.floor(num("BENCH_SLOW_NUMBERS", 0, 0, NUMBERS - 1));
const ERRORS = process.env.BENCH_ERRORS === "none" ? "" : (process.env.BENCH_ERRORS ?? "5xx=0.01,429=0.005,131056=0.002,async_131026=0.003,timeout=0.005");
const OUT = resolve(root, process.env.BENCH_OUT ?? "dist/worker-bench");
const BATCH_SIZE = 2000;
// BENCH_QUIET_PCT=35: espera (até BENCH_QUIET_WAIT_S=300) a máquina ficar abaixo desse uso total antes de começar (máquina compartilhada suja a medida). 0 = não espera.
const QUIET_PCT = num("BENCH_QUIET_PCT", 0, 0, 100);
const QUIET_WAIT_S = num("BENCH_QUIET_WAIT_S", 300, 10, 3600);
// BENCH_PRIORITY=above: processos da bancada com prioridade acima do normal (só durante a execução; útil quando outros processos disputam a CPU).
const PRIORITY_ABOVE = process.env.BENCH_PRIORITY === "above";
// pglite = SQL real das migrations (1 conexão, WASM); memory = as mesmas RPCs em JS, sem custo de banco (isola a CPU do worker).
const DB_MODE = process.env.BENCH_DB === "memory" ? "memory" : "pglite";

const hex = (n: number) => n.toString(16).padStart(12, "0");
const session = (i: number) => `10000000-0000-4000-8000-${hex(i + 1)}`;
const campaign = (i: number) => `20000000-0000-4000-8000-${hex(i + 1)}`;
const ACCOUNT = "30000000-0000-4000-8000-000000000001";
const short = (id: string) => `#${Number.parseInt(id.slice(-12), 16)}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const children: ChildProcess[] = [];
const cleanup = () => children.forEach((c) => !c.killed && c.kill());
process.on("exit", cleanup);
for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => (cleanup(), process.exit(130)));

// O ambiente dos processos filhos é montado do zero (sem as chaves do disparador do shell).
const baseEnv = Object.fromEntries(["PATH", "Path", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE", "ComSpec"].filter((k) => process.env[k]).map((k) => [k, process.env[k] as string]));

async function startDb(): Promise<{ db: BenchDb; port: number }> {
  const child: ChildProcess = spawn(process.execPath, [resolve(dir, "db-host.mjs")], { cwd: root, env: { ...baseEnv, BENCH_DB: DB_MODE } as unknown as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "inherit"] });
  children.push(child);
  boost(child);
  const port = await new Promise<number>((ok, fail) => {
    let buf = "";
    child.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      const m = buf.match(/READY (\d+)/);
      if (m) ok(Number(m[1]));
    });
    child.once("exit", (code) => fail(new Error(`db-host saiu com código ${code}`)));
  });
  return { db: await BenchDb.connect(port), port };
}

const mockCpu: Array<{ at: number; cpuMs: number; lagP99Ms: number }> = [];
async function startMock(): Promise<string> {
  const child: ChildProcess = spawn(process.execPath, [resolve(dir, "mock-host.mjs")], {
    cwd: root,
    env: {
      ...baseEnv,
      MOCK_PORT: String(41_000 + Math.floor(Math.random() * 2_000)),
      MOCK_LATENCY_P50_MS: String(P50),
      MOCK_LATENCY_P95_MS: String(P95),
      MOCK_ERRORS: ERRORS,
    } as unknown as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(child);
  boost(child);
  let buf = "";
  return new Promise<string>((ok, fail) => {
    child.once("exit", (code) => fail(new Error(`mock-host saiu com código ${code}`)));
    child.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const ready = line.match(/^READY (\d+)/);
        if (ready) ok(`http://127.0.0.1:${ready[1]}`);
        const cpu = line.match(/^CPU (\d+) (\d+)/);
        if (cpu) mockCpu.push({ at: Date.now(), cpuMs: Number(cpu[1]), lagP99Ms: Number(cpu[2]) });
      }
    });
  });
}

const seed = (db: BenchDb, rowsPerNumber: number) =>
  db.seed({ account: ACCOUNT, rowsPerNumber, numbers: Array.from({ length: NUMBERS }, (_, i) => ({ sessionId: session(i), campaignId: campaign(i) })) });

async function main() {
  const rowsPerNumber = Math.ceil(RATE * (WARMUP_S + DURATION_S + 30) * 1.25);
  console.log(`[bancada] ${NUMBERS} números × ${RATE}/s em ${WORKERS} processo(s); ${WARMUP_S}s de aquecimento + ${DURATION_S}s medidos; ${rowsPerNumber} itens por número`);
  const [{ db, port }, metaUrl] = await Promise.all([startDb(), startMock()]);
  const tSeed = performance.now();
  await seed(db, rowsPerNumber);
  console.log(`[bancada] semeado em ${fixed((performance.now() - tSeed) / 1000)} s (${NUMBERS * rowsPerNumber} itens)`);
  if (SLOW > 0) {
    const phoneLatency = Object.fromEntries(Array.from({ length: SLOW }, (_, i) => [session(i), { p50: 3000, p95: 3500 }]));
    await fetch(`${metaUrl}/__control`, { method: "POST", body: JSON.stringify({ phoneLatency }) });
  }

  if (QUIET_PCT > 0) console.log(`[bancada] máquina ociosa (${fixed(await waitForQuietMachine(), 0)} % de uso); começando`);
  const perWorker = Math.ceil(NUMBERS / WORKERS);
  const t0 = Date.now() + 8_000 + WORKERS * 1_500; // tempo de subir os processos (tsx compila na hora)
  const results: WorkerBenchResult[] = [];
  const exits: Promise<void>[] = [];
  for (let w = 0; w < WORKERS; w++) {
    const ids = Array.from({ length: NUMBERS }, (_, i) => i).filter((i) => Math.floor(i / perWorker) === w);
    if (ids.length === 0) continue;
    const config: WorkerBenchConfig = {
      dbPort: port,
      metaUrl,
      owner: `bancada-${w + 1}`,
      numbers: ids.map((i) => ({ sessionId: session(i), campaignId: campaign(i) })),
      ratePerSecond: RATE,
      t0,
      warmupS: WARMUP_S,
      durationS: DURATION_S,
      roundMs: ROUND_MS,
      batchSize: BATCH_SIZE,
    };
    const child = fork(resolve(dir, "worker-proc.ts"), [], {
      cwd: root,
      execArgv: ["--import", "tsx"],
      // Vagas do processo = o que o worker real precisaria (≈ 96 por número a 80/s), dentro do teto global de 400.
      env: { ...baseEnv, BENCH_WORKER: JSON.stringify(config), DISPATCH_PROCESS_CONCURRENCY: String(Math.min(400, ids.length * 110)), BENCH_BARRIER: process.env.BENCH_BARRIER === "1" ? "1" : "0" } as unknown as NodeJS.ProcessEnv,
    });
    children.push(child);
    boost(child);
    exits.push(
      new Promise((ok, fail) => {
        child.on("message", (m: { type?: string; result?: WorkerBenchResult }) => m?.type === "result" && m.result && results.push(m.result));
        child.once("exit", (code) => (code === 0 ? ok() : fail(new Error(`worker ${w + 1} saiu com código ${code}`))));
      }),
    );
  }

  // Estatísticas do banco só da janela medida.
  await sleep(Math.max(0, t0 + WARMUP_S * 1000 - Date.now()));
  await db.stats(true);
  const machineBefore = machineTimes();
  await sleep(DURATION_S * 1000);
  const dbStats = await db.stats();
  const machine = machineUsage(machineBefore);
  const inWindow = mockCpu.filter((s) => s.at >= t0 + WARMUP_S * 1000 && s.at <= t0 + (WARMUP_S + DURATION_S) * 1000 + 1500);
  const mockWindow = {
    cores: inWindow.length > 1 ? (inWindow[inWindow.length - 1].cpuMs - inWindow[0].cpuMs) / (inWindow[inWindow.length - 1].at - inWindow[0].at) : 0,
    lagP99MaxMs: Math.max(0, ...inWindow.map((s) => s.lagP99Ms)),
  };
  await Promise.race([Promise.all(exits), sleep(90_000).then(() => Promise.reject(new Error("workers não terminaram em 90 s")))]);

  const mock = (await (await fetch(`${metaUrl}/__stats`)).json()) as { phones: Record<string, { total: number; ok: number; errors: Record<string, number>; max_in_flight: number }> };
  const { statuses: leftovers, duplicates } = await db.summary();
  db.close();

  const report = buildReport({ results, dbStats, mock, leftovers, duplicates, rowsPerNumber, machine, mockWindow });
  console.log(report.text);
  mkdirSync(OUT, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(resolve(OUT, `${stamp}.json`), JSON.stringify({ params: report.params, summary: report.summary, results }, null, 1));
  writeFileSync(resolve(OUT, `${stamp}.md`), report.text);
  console.log(`\n[bancada] salvo em ${resolve(OUT, stamp)}.{json,md}`);
  cleanup();
  process.exit(report.summary.ok ? 0 : 1);
}

interface ReportInput {
  results: WorkerBenchResult[];
  dbStats: Awaited<ReturnType<BenchDb["stats"]>>;
  mock: { phones: Record<string, { total: number; ok: number; errors: Record<string, number>; max_in_flight: number }> };
  leftovers: Array<{ status: string; n: number }>;
  duplicates: number;
  rowsPerNumber: number;
  machine: { busyPct: number; logicalCores: number; model: string };
  mockWindow: { cores: number; lagP99MaxMs: number };
}

function buildReport({ results, dbStats, mock, leftovers, duplicates, rowsPerNumber, machine, mockWindow }: ReportInput) {
  const rates = results.flatMap((r) => r.numbers.map((id) => numberRate(id, windowOf(r.perSecond[id] ?? [], WARMUP_S, DURATION_S))));
  rates.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  const fair = fairness(rates, RATE);
  const aggregate = sum(rates.map((r) => r.mean));
  const target = NUMBERS * RATE;
  const claim = results.flatMap((r) => r.claimMs);
  const confirm = results.flatMap((r) => r.confirmMs);
  const svc = dbStats.service;
  const callsPerS = (fn: string) => (svc[fn]?.length ?? 0) / DURATION_S;
  const cpuTotal = sum(results.map((r) => r.cpu.cpuMs));
  const sendsTotal = sum(rates.map((r) => r.sends));
  const cap = capacityPerCore(cpuTotal, sendsTotal, RATE);
  const started = sum(results.map((r) => r.counts.started));
  const mockTotal = sum(Object.values(mock.phones).map((p) => p.total));
  const lost = results.flatMap((r) => r.leasesLost);
  const errs: Record<string, number> = {};
  for (const r of results) for (const [k, v] of Object.entries(r.counts.httpErrors)) errs[k] = (errs[k] ?? 0) + v;
  const timeouts = sum(results.map((r) => r.counts.timeouts));
  const ms = (v: number) => fixed(v, v < 10 ? 2 : 1);
  const svcLine = (fn: string) => `| \`${fn}\` | ${fixed(callsPerS(fn), 1)} | ${ms(percentile(svc[fn] ?? [], 50))} | ${ms(percentile(svc[fn] ?? [], 95))} | ${ms(percentile(svc[fn] ?? [], 99))} |`;
  const ok = aggregate >= target * 0.95 && fair.minOverTarget >= 0.9 && duplicates === 0 && lost.length === 0;
  const lines: string[] = [];
  lines.push(`## Resultado — ${NUMBERS} números × ${RATE}/s (${WORKERS} processo(s), banco ${DB_MODE === "memory" ? "em memória (RPCs em JS, sem custo de banco)" : "PGlite (SQL real, 1 conexão)"}, ${DURATION_S} s medidos após ${WARMUP_S} s de aquecimento)`);
  lines.push("");
  lines.push(`**Vazão agregada: ${fixed(aggregate, 0)} envios/s** (meta ${target}) = ${fixed((aggregate / target) * 100, 1)} % da meta · ${fixed(aggregate * 60, 0)}/min`);
  lines.push(`**Justiça:** Jain ${fixed(fair.jain, 4)} · menor ÷ maior ${fixed(fair.minOverMax, 3)} · menor ÷ meta ${fixed(fair.minOverTarget, 3)}`);
  lines.push(`**Máquina:** ${machine.model}, ${machine.logicalCores} núcleos lógicos; uso total na janela **${fixed(machine.busyPct, 0)} %** (workers: ${fixed(sum(results.map((r) => coresUsed(r.cpu))), 2)} núcleos; Meta simulada: ${fixed(mockWindow.cores, 2)} núcleos, lag p99 máx ${mockWindow.lagP99MaxMs} ms; banco da bancada: ${fixed(dbStats.cpu_ms / 1000, 0)} s de CPU acumulada; o resto são outros processos da máquina).`);
  lines.push("");
  lines.push("### Por número (envios iniciados/s na janela medida)");
  lines.push("");
  lines.push("| Número | média/s | pico/s | pior trecho 5 s | envios |");
  lines.push("|---|---:|---:|---:|---:|");
  const shown = rates.length > 24 ? rates.slice(0, 24) : rates;
  for (const r of shown) lines.push(`| ${short(r.sessionId)} | ${fixed(r.mean)} | ${r.peak} | ${fixed(r.worst5s)} | ${r.sends} |`);
  lines.push("");
  lines.push("### Claim e confirmação");
  lines.push("");
  lines.push("| Medida | p50 | p95 | p99 |");
  lines.push("|---|---:|---:|---:|");
  lines.push(`| claim visto pelo worker (ms, com fila no banco) | ${ms(percentile(claim, 50))} | ${ms(percentile(claim, 95))} | ${ms(percentile(claim, 99))} |`);
  lines.push(`| confirmação em lote, do submit ao gravado (ms) | ${ms(percentile(confirm, 50))} | ${ms(percentile(confirm, 95))} | ${ms(percentile(confirm, 99))} |`);
  lines.push("");
  lines.push(DB_MODE === "memory" ? "Tempo de **serviço** no banco em memória (só o custo do JS; **não** representa o SQL):" : "Tempo de **serviço** no banco (sem fila; PGlite/WASM, 1 conexão):");
  lines.push("");
  lines.push("| Função | chamadas/s | p50 ms | p95 ms | p99 ms |");
  lines.push("|---|---:|---:|---:|---:|");
  for (const fn of ["claim_dispatch_batch_rated", "confirm_dispatch_items_sent", "count_due_dispatch_items", "unclaim_dispatch_items", "renew_dispatch_leases"]) if (svc[fn]) lines.push(svcLine(fn));
  lines.push("");
  lines.push(`Banco ocupado **${fixed((dbStats.busy_s / dbStats.uptime_s) * 100, 0)} %** do tempo da janela; **${fixed((dbStats.busy_s * 1000) / Math.max(1, sendsTotal), 2)} ms de banco por envio** (≈ 100 % ocupado = o banco da bancada saturou e a vazão passa a medir o PGlite, não o worker).`);
  lines.push("");
  lines.push("### CPU, memória e laço de eventos por processo worker");
  lines.push("");
  lines.push("| Worker | números | núcleos usados | CPU ms/envio | RSS máx MB | lag p99 ms | lag máx ms | rodadas (média ms) |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of results.sort((a, b) => a.owner.localeCompare(b.owner))) {
    const sends = sum(r.numbers.map((id) => windowOf(r.perSecond[id] ?? [], WARMUP_S, DURATION_S).reduce((a, b) => a + b, 0)));
    lines.push(`| ${r.owner} | ${r.numbers.length} | ${fixed(coresUsed(r.cpu), 2)} | ${fixed(sends ? r.cpu.cpuMs / sends : 0, 2)} | ${fixed(r.rssMaxMb, 0)} | ${fixed(r.lag.p99Ms)} | ${fixed(r.lag.maxMs)} | ${r.rounds.count} (${fixed(r.rounds.meanMs, 0)}) |`);
  }
  lines.push("");
  lines.push(`### Capacidade por núcleo (extrapolação linear do custo de CPU medido: **${fixed(cap.cpuMsPerSend, 3)} ms/envio**)`);
  lines.push("");
  lines.push(`- Núcleo a 100 %: **${fixed(cap.numbersPerCoreFull)} números a ${RATE}/s**; com folga de 30 % (70 % de uso): **${fixed(cap.numbersPerCoreSafe)} números**.`);
  lines.push(`- Piso: a CPU não inclui \`processQueueItem\` (template, decifrar token, PostgREST/TLS); o número real por núcleo é MENOR.`);
  lines.push("");
  lines.push("### Conferências");
  lines.push("");
  lines.push(`- Meta simulada recebeu ${mockTotal} requisições na rodada inteira; os workers iniciaram ${started} (diferença = fora da janela de contagem: ${mockTotal - started}).`);
  lines.push(`- Erros da Meta simulada vistos pelos workers: ${Object.entries(errs).map(([k, v]) => `HTTP ${k} ×${v}`).join(", ") || "nenhum"}; timeouts do cliente: ${timeouts}.`);
  lines.push(`- Itens duplicados por id do provedor: **${duplicates}** · leases perdidos: **${lost.length}** · confirmações com erro: ${sum(results.map((r) => r.counts.confirmErrors))}.`);
  lines.push(`- Fila final: ${leftovers.map((l) => `${l.status}=${l.n}`).join(", ")} (semeados ${rowsPerNumber} por número).`);
  lines.push(`- Vagas por número ${results[0]?.slotsPerNumber} · teto global do processo ${results[0]?.globalConcurrency} · pico em voo na Meta simulada ${Math.max(0, ...Object.values(mock.phones).map((p) => p.max_in_flight))}/número.`);
  lines.push("");
  lines.push(ok ? "✅ **Aceite da bancada:** ≥ 95 % da meta, nenhum número abaixo de 90 % da taxa, zero duplicado, zero lease perdido." : "⚠️ **Fora do aceite da bancada** (≥ 95 % da meta, menor número ≥ 90 % da taxa, zero duplicado, zero lease perdido): leia as tabelas acima.");
  return {
    text: lines.join("\n"),
    params: { NUMBERS, WORKERS, RATE, DURATION_S, WARMUP_S, ROUND_MS, P50, P95, SLOW, ERRORS, DB_MODE, PRIORITY_ABOVE, QUIET_PCT, BARRIER: process.env.BENCH_BARRIER === "1" },
    summary: { aggregatePerSecond: aggregate, target, fairness: fair, claimClientP95Ms: percentile(claim, 95), cpuMsPerSend: cap.cpuMsPerSend, numbersPerCoreFull: cap.numbersPerCoreFull, numbersPerCoreSafe: cap.numbersPerCoreSafe, dbBusyPct: (dbStats.busy_s / dbStats.uptime_s) * 100, ok },
  };
}

main().catch((error) => {
  console.error("[bancada] falhou:", error);
  cleanup();
  process.exit(1);
});

// Uso total da máquina na janela medida (inclui o que NÃO é da bancada: outros processos disputam o mesmo CPU e sujam a medida).
function machineTimes() {
  return cpus().map((c) => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a, b) => a + b, 0) }));
}
function machineUsage(before: ReturnType<typeof machineTimes>) {
  const after = machineTimes();
  const idle = sum(after.map((c, i) => c.idle - before[i].idle));
  const total = sum(after.map((c, i) => c.total - before[i].total));
  return { busyPct: total > 0 ? (1 - idle / total) * 100 : 0, logicalCores: after.length, model: cpus()[0]?.model.trim() ?? "?" };
}

function boost(child: ChildProcess) {
  if (!PRIORITY_ABOVE || !child.pid) return;
  try {
    setPriority(child.pid, osConstants.priority.PRIORITY_ABOVE_NORMAL);
  } catch {
    /* sem permissão: segue na prioridade normal */
  }
}

async function waitForQuietMachine(): Promise<number> {
  let busy = 100;
  const deadline = Date.now() + QUIET_WAIT_S * 1000;
  while (Date.now() < deadline) {
    const before = machineTimes();
    await sleep(3_000);
    busy = machineUsage(before).busyPct;
    if (busy <= QUIET_PCT) return busy;
  }
  console.warn(`[bancada] a máquina não ficou abaixo de ${QUIET_PCT} % em ${QUIET_WAIT_S} s (último: ${fixed(busy, 0)} %); seguindo mesmo assim`);
  return busy;
}

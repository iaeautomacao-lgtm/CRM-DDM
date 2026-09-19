// Passo 5 — consolida os resultados de import/queue/webhook (o que tiver
// rodado) num único relatório, identifica onde o import degrada, o
// throughput real do cron e a latência do webhook sob carga.
import fs from "node:fs";
import path from "node:path";
import { RESULTS_DIR } from "./config";

interface ImportResult {
  size: number;
  durationMs: number;
  ok: boolean;
  importados: number;
  httpStatus: number | null;
  errorMessage?: string;
}

function readJsonIfExists<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function analyzeImport(results: ImportResult[] | null) {
  if (!results || results.length === 0) {
    return { ranAt: null, note: "test-import.ts não rodou (sem import-results.json)." };
  }

  const successful = results.filter((r) => r.ok);
  const firstFailure = results.find((r) => !r.ok);

  // Degradação: taxa linhas/segundo caindo consistentemente indica que o
  // tamanho anterior ainda estava numa faixa saudável e o atual não —
  // reporta a curva completa em vez de um único "limite" arbitrário, já
  // que o que conta como degradação depende do SLA de quem for ler isto.
  const throughputCurve = successful.map((r) => ({
    size: r.size,
    durationMs: r.durationMs,
    rowsPerSecond: Math.round((r.size / (r.durationMs / 1000)) * 100) / 100,
  }));

  let degradationStartsAt: number | null = null;
  for (let i = 1; i < throughputCurve.length; i++) {
    // Queda de mais de 40% no rows/sec em relação ao ponto anterior —
    // heurística simples pra apontar onde olhar primeiro, não uma
    // verdade absoluta.
    const prev = throughputCurve[i - 1].rowsPerSecond;
    const curr = throughputCurve[i].rowsPerSecond;
    if (prev > 0 && curr < prev * 0.6) {
      degradationStartsAt = throughputCurve[i].size;
      break;
    }
  }

  return {
    sizesTested: results.map((r) => r.size),
    allSucceeded: !firstFailure,
    firstFailureAt: firstFailure?.size ?? null,
    firstFailureReason: firstFailure?.errorMessage ?? null,
    throughputCurve,
    degradationStartsAt,
  };
}

interface QueueResult {
  enqueued: number;
  drained: boolean;
  avgThroughputItemsPerMinute: number;
  finalCounts: Record<string, number>;
  totalDurationMs: number;
}

function analyzeQueue(result: QueueResult | null) {
  if (!result) {
    return { ranAt: null, note: "test-queue.ts não rodou (sem queue-results.json)." };
  }
  return {
    enqueued: result.enqueued,
    drained: result.drained,
    avgThroughputItemsPerMinute: result.avgThroughputItemsPerMinute,
    finalCounts: result.finalCounts,
    totalDurationMinutes: Math.round((result.totalDurationMs / 60_000) * 100) / 100,
  };
}

interface WebhookSummary {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  errors: number;
  count: number;
}
interface WebhookResult {
  tierA: Record<number, WebhookSummary>;
  tierB: {
    concurrency: Record<number, WebhookSummary>;
    redelivery: { dedupHeld: boolean; finalMessageCount: number; requestsSent: number };
  } | null;
}

function analyzeWebhook(result: WebhookResult | null) {
  if (!result) {
    return { ranAt: null, note: "test-webhook.ts não rodou (sem webhook-results.json)." };
  }
  const levels = Object.keys(result.tierA).map(Number).sort((a, b) => a - b);
  const highestLevel = levels[levels.length - 1];
  return {
    tierA: {
      concurrencyLevelsTested: levels,
      atHighestConcurrency: highestLevel != null ? result.tierA[highestLevel] : null,
    },
    tierBRan: !!result.tierB,
    dedupHeld: result.tierB?.redelivery.dedupHeld ?? null,
    dedupDetail: result.tierB?.redelivery ?? null,
  };
}

function main() {
  const importResults = readJsonIfExists<ImportResult[]>(path.join(RESULTS_DIR, "import-results.json"));
  const queueResult = readJsonIfExists<QueueResult>(path.join(RESULTS_DIR, "queue-results.json"));
  const webhookResult = readJsonIfExists<WebhookResult>(path.join(RESULTS_DIR, "webhook-results.json"));

  const report = {
    generatedAt: new Date().toISOString(),
    import: analyzeImport(importResults),
    queue: analyzeQueue(queueResult),
    webhook: analyzeWebhook(webhookResult),
  };

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(RESULTS_DIR, `report_${timestamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf-8");

  console.log("\n=========================================");
  console.log(" RELATÓRIO DE STRESS TEST — CRM-DDM");
  console.log("=========================================\n");

  console.log("-- IMPORT --");
  if (report.import.note) {
    console.log(`  ${report.import.note}`);
  } else {
    console.log(`  Tamanhos testados: ${report.import.sizesTested?.join(", ")}`);
    console.log(`  Todos passaram: ${report.import.allSucceeded ? "sim" : "não"}`);
    if (report.import.firstFailureAt) {
      console.log(`  Primeira falha em: ${report.import.firstFailureAt} linhas (${report.import.firstFailureReason})`);
    }
    if (report.import.degradationStartsAt) {
      console.log(`  Degradação de throughput a partir de: ${report.import.degradationStartsAt} linhas`);
    }
    console.log(`  Curva de throughput:`);
    for (const point of report.import.throughputCurve ?? []) {
      console.log(`    ${point.size} linhas — ${point.durationMs}ms — ${point.rowsPerSecond} linhas/s`);
    }
  }

  console.log("\n-- FILA DO DISPARADOR (CRON) --");
  if (report.queue.note) {
    console.log(`  ${report.queue.note}`);
  } else {
    console.log(`  Itens enfileirados: ${report.queue.enqueued}`);
    console.log(`  Drenou dentro do timeout: ${report.queue.drained ? "sim" : "não"}`);
    console.log(`  Throughput médio: ${report.queue.avgThroughputItemsPerMinute} itens/min`);
    console.log(`  Contagem final por status: ${JSON.stringify(report.queue.finalCounts)}`);
  }

  console.log("\n-- WEBHOOK --");
  if (report.webhook.note) {
    console.log(`  ${report.webhook.note}`);
  } else {
    const top = report.webhook.tierA?.atHighestConcurrency;
    console.log(
      `  Tier A (sem canal real), maior concorrência testada: p50=${top?.p50Ms}ms p95=${top?.p95Ms}ms p99=${top?.p99Ms}ms, erros=${top?.errors}/${top?.count}`
    );
    if (report.webhook.tierBRan) {
      console.log(`  Tier B (pipeline completo) rodou — UNIQUE de message_id segurou: ${report.webhook.dedupHeld ? "SIM" : "NÃO — investigar!"}`);
    } else {
      console.log(`  Tier B não rodou — sem STRESS_WEBHOOK_PHONE_NUMBER_ID (ver README.md).`);
    }
  }

  console.log(`\n[report] Relatório completo salvo em ${outPath}`);
}

main();

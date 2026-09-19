// Passo 4 — carga no webhook do WhatsApp (/api/whatsapp/webhook), sempre
// contra LOCAL_URL (nunca produção — ver config.ts) e sem envolver a Meta
// de verdade: os payloads são fabricados aqui, o webhook só processa o
// JSON que ele recebe.
//
// Dois níveis:
//
//   Tier A (sempre roda, sem pré-requisitos além de STRESS_META_APP_SECRET)
//     Usa um phone_number_id fictício que não bate com nenhum
//     wacrm.whatsapp_config — a verificação HMAC ainda roda de ponta a
//     ponta (cai no fallback process.env.META_APP_SECRET, ver
//     verifyMetaWebhookSignature em webhook-signature.ts), mas
//     processWebhook() não encontra canal e descarta a mensagem sem
//     tocar em contacts/conversations/messages. Mede a latência/
//     throughput da camada HTTP + verificação de assinatura sob carga.
//
//   Tier B (opcional — requer STRESS_WEBHOOK_PHONE_NUMBER_ID)
//     Usa um canal de teste real (phone_number_id de um
//     wacrm.whatsapp_config provisionado manualmente pelo operador — ver
//     README.md) para exercitar o pipeline completo: findOrCreateContact,
//     findOrCreateConversation, insert em messages, e o UNIQUE de
//     message_id (migration 088) sob redelivery concorrente. Este script
//     NUNCA cria esse canal sozinho — inserir credenciais falsas em
//     wacrm.whatsapp_config é responsabilidade do operador, que conhece o
//     schema ao vivo da própria instância (ver nota sobre drift de schema
//     no README).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import {
  LOCAL_URL,
  META_APP_SECRET,
  RESULTS_DIR,
  STRESS_PREFIX,
  WEBHOOK_CONCURRENCY_LEVELS,
  WEBHOOK_TEST_PHONE_NUMBER_ID,
  supabaseAdmin,
} from "./config";

const WEBHOOK_URL = `${LOCAL_URL}/api/whatsapp/webhook`;

function signPayload(rawBody: string): string {
  const hmac = crypto.createHmac("sha256", META_APP_SECRET()).update(rawBody).digest("hex");
  return `sha256=${hmac}`;
}

function buildPayload(opts: {
  phoneNumberId: string;
  messageId: string;
  fromPhone: string;
  name: string;
  text: string;
}) {
  return {
    entry: [
      {
        id: "stress-test-entry",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: opts.fromPhone,
                phone_number_id: opts.phoneNumberId,
              },
              contacts: [{ profile: { name: opts.name }, wa_id: opts.fromPhone }],
              messages: [
                {
                  id: opts.messageId,
                  from: opts.fromPhone,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: opts.text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

interface RequestOutcome {
  status: number | null;
  durationMs: number;
  error?: string;
}

async function sendWebhook(payload: object): Promise<RequestOutcome> {
  const rawBody = JSON.stringify(payload);
  const signature = signPayload(rawBody);
  const start = Date.now();
  try {
    const response = await axios.post(WEBHOOK_URL, rawBody, {
      headers: {
        "Content-Type": "application/json",
        "x-hub-signature-256": signature,
      },
      timeout: 30_000,
      validateStatus: () => true,
    });
    return { status: response.status, durationMs: Date.now() - start };
  } catch (err: any) {
    return { status: null, durationMs: Date.now() - start, error: err.message };
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function summarize(outcomes: RequestOutcome[]) {
  const durations = outcomes.map((o) => o.durationMs).sort((a, b) => a - b);
  const errors = outcomes.filter((o) => o.status === null || o.status >= 400);
  return {
    count: outcomes.length,
    errors: errors.length,
    statusBreakdown: outcomes.reduce<Record<string, number>>((acc, o) => {
      const key = String(o.status ?? "network_error");
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    p99Ms: percentile(durations, 99),
    minMs: durations[0] ?? 0,
    maxMs: durations[durations.length - 1] ?? 0,
  };
}

async function runConcurrencyLevel(n: number, phoneNumberId: string) {
  const payloads = Array.from({ length: n }, (_, i) =>
    buildPayload({
      phoneNumberId,
      messageId: `${STRESS_PREFIX}_load_${Date.now()}_${i}_${crypto.randomUUID()}`,
      fromPhone: `55999${String(1_000_000 + i).padStart(7, "0")}`,
      name: `${STRESS_PREFIX}_WebhookLoad`,
      text: `${STRESS_PREFIX} carga concorrente #${i}`,
    })
  );

  const outcomes = await Promise.all(payloads.map((p) => sendWebhook(p)));
  return summarize(outcomes);
}

async function runTierA() {
  console.log(`\n[test-webhook] Tier A — carga HTTP pura (sem canal real).`);
  const fakePhoneNumberId = `${STRESS_PREFIX}_no_channel_${crypto.randomUUID()}`;
  const results: Record<number, ReturnType<typeof summarize>> = {};

  for (const n of WEBHOOK_CONCURRENCY_LEVELS) {
    process.stdout.write(`[test-webhook] Disparando ${n} requests simultâneos... `);
    const summary = await runConcurrencyLevel(n, fakePhoneNumberId);
    results[n] = summary;
    console.log(
      `p50=${summary.p50Ms}ms p95=${summary.p95Ms}ms p99=${summary.p99Ms}ms erros=${summary.errors}/${summary.count}`
    );
  }

  return results;
}

async function waitForMessageCount(
  messageId: string,
  expectedAtLeast: number,
  timeoutMs: number
): Promise<number> {
  const db = supabaseAdmin();
  const start = Date.now();
  let lastCount = 0;
  while (Date.now() - start < timeoutMs) {
    const { count } = await db
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("message_id", messageId);
    lastCount = count ?? 0;
    if (lastCount >= expectedAtLeast) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  // Espera extra depois de ver a primeira linha, para pegar uma segunda
  // escrita atrasada que provaria que o UNIQUE falhou em bloquear a
  // duplicata (redelivery é assíncrono via after(), ver webhook/route.ts).
  await new Promise((r) => setTimeout(r, 3000));
  const { count: finalCount } = await db
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("message_id", messageId);
  return finalCount ?? lastCount;
}

async function runTierB(phoneNumberId: string) {
  console.log(`\n[test-webhook] Tier B — pipeline completo (canal: ${phoneNumberId}).`);

  // 4a. Mesma carga concorrente do Tier A, mas através do pipeline real
  // (contact/conversation/message insert de verdade).
  const results: Record<number, ReturnType<typeof summarize>> = {};
  for (const n of WEBHOOK_CONCURRENCY_LEVELS) {
    process.stdout.write(`[test-webhook] (Tier B) Disparando ${n} requests simultâneos... `);
    const summary = await runConcurrencyLevel(n, phoneNumberId);
    results[n] = summary;
    console.log(
      `p50=${summary.p50Ms}ms p95=${summary.p95Ms}ms p99=${summary.p99Ms}ms erros=${summary.errors}/${summary.count}`
    );
  }

  // 4b. Redelivery — mesmo message_id, N requisições concorrentes.
  // messages.message_id tem UNIQUE (migration 088); processMessage trata
  // 23505 como "já processada" e não é erro real (ver webhook/route.ts).
  console.log(`[test-webhook] Testando redelivery (mesmo message_id, 5 requisições concorrentes)...`);
  const dedupMessageId = `${STRESS_PREFIX}_dedup_${crypto.randomUUID()}`;
  const dedupPayload = buildPayload({
    phoneNumberId,
    messageId: dedupMessageId,
    fromPhone: "5599900000099",
    name: `${STRESS_PREFIX}_WebhookDedup`,
    text: `${STRESS_PREFIX} teste de redelivery`,
  });
  const redeliveryOutcomes = await Promise.all(
    Array.from({ length: 5 }, () => sendWebhook(dedupPayload))
  );
  const allAccepted = redeliveryOutcomes.every((o) => o.status === 200);

  const finalMessageCount = await waitForMessageCount(dedupMessageId, 1, 15_000);
  const dedupHeld = finalMessageCount === 1;

  console.log(
    `[test-webhook] Redelivery: ${redeliveryOutcomes.length} requests, ` +
      `todas aceitas (200)=${allAccepted}, linhas em messages=${finalMessageCount} ` +
      `(esperado 1) — UNIQUE segurou? ${dedupHeld ? "SIM" : "NÃO — investigar!"}`
  );

  return {
    concurrency: results,
    redelivery: {
      requestsSent: redeliveryOutcomes.length,
      allAccepted,
      messageIdUsed: dedupMessageId,
      finalMessageCount,
      dedupHeld,
    },
  };
}

async function main() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  console.log(`[test-webhook] Alvo: ${WEBHOOK_URL} (sempre local, nunca produção)`);

  const tierA = await runTierA();

  const phoneNumberId = WEBHOOK_TEST_PHONE_NUMBER_ID();
  const tierB = phoneNumberId ? await runTierB(phoneNumberId) : null;

  if (!phoneNumberId) {
    console.log(
      `\n[test-webhook] Tier B pulado — STRESS_WEBHOOK_PHONE_NUMBER_ID não definido. ` +
        `Sem um canal de teste real, não é possível verificar o UNIQUE de message_id ` +
        `nem medir o pipeline completo (contact/conversation/message insert). Ver README.md.`
    );
  }

  const report = {
    tierA,
    tierB,
    generatedAt: new Date().toISOString(),
  };

  const outPath = path.join(RESULTS_DIR, "webhook-results.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf-8");
  console.log(`[test-webhook] Resultados salvos em ${outPath}`);
}

main().catch((err) => {
  console.error("[test-webhook] Erro fatal:", err.message);
  process.exit(1);
});

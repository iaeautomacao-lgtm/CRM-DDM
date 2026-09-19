// Passo 3 — testa a fila do Disparador de ponta a ponta:
//   1. Importa 1000 contatos de teste (reusa csv_001000.csv — rode
//      "npm run stress:generate" antes se ainda não existir).
//   2. Cria um canal WAHA descartável em wacrm.whatsapp_config apontando
//      para um host inexistente (ver createTestChannel) e uma campanha
//      que usa esse canal como session_id.
//   3. Inicia a campanha via POST /start (mesma rota de produção).
//   4. Faz polling em disp_message_queue a cada 30s, contando itens por
//      status, até a fila drenar ou o timeout de 10min bater.
//   5. Remove o canal descartável ao final (best-effort — cleanup.ts
//      também o pega numa varredura geral, ver README).
//
// Por que um canal de verdade em vez de um session_id qualquer:
//   disp_message_queue.session_id tem FOREIGN KEY para whatsapp_config(id)
//   no schema ao vivo (não documentada em nenhuma migration deste repo —
//   mais um caso de drift, ver README) — um UUID que não existe faz o
//   INSERT da fila falhar com 23503 antes mesmo da campanha iniciar,
//   então "canal inexistente" não é uma opção viável. Usamos WAHA (não
//   Meta) para o canal descartável porque a checagem de janela de 24h em
//   startCampaign.ts só se aplica a canais Meta sem template — um canal
//   WAHA deixa os itens irem para a fila como 'agendado' de verdade, que
//   é o que queremos observar o cron processar. waha_url aponta para um
//   host no TLD reservado .invalid (RFC 2606): assertWahaUrlIsSafe
//   (src/lib/whatsapp/waha-api.ts) deixa passar hosts públicos que
//   simplesmente não resolvem — a falha de DNS acontece só na hora do
//   fetch, sem nenhuma requisição de rede real chegar a lugar nenhum.
//
// Requer que o cron de produção (crontab batendo em /api/disparador/cron
// a cada minuto) esteja rodando — este script só observa, nunca chama o
// cron diretamente.
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import FormData from "form-data";
import { randomUUID } from "node:crypto";
import {
  ACCOUNT_ID,
  DATA_DIR,
  QUEUE_POLL_INTERVAL_MS,
  QUEUE_TEST_CONTACT_COUNT,
  QUEUE_TEST_TIMEOUT_MS,
  RESULTS_DIR,
  SESSION_TOKEN,
  STRESS_PREFIX,
  TARGET_URL,
  USER_ID,
  supabaseAdmin,
} from "./config";

const QUEUE_STATUSES = [
  "agendado",
  "enviando",
  "enviado",
  "entregue",
  "lido",
  "erro",
  "pausado",
  "pendente",
] as const;
type QueueStatus = (typeof QUEUE_STATUSES)[number];

interface PollSnapshot {
  atMs: number;
  elapsedMs: number;
  counts: Record<string, number>;
  total: number;
  inFlight: number; // agendado + enviando + pendente
}

async function importTestContacts(sessionCookie: string): Promise<void> {
  const filename = "csv_001000.csv";
  const filePath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(`${filename} não encontrado. Rode "npm run stress:generate" primeiro.`);
  }

  const form = new FormData();
  form.append("file", fs.createReadStream(filePath), filename);
  form.append("defaultTag", STRESS_PREFIX);

  console.log(`[test-queue] Importando ${QUEUE_TEST_CONTACT_COUNT} contatos de teste...`);
  const response = await axios.post(`${TARGET_URL}/api/disparador/contacts/import`, form, {
    headers: { ...form.getHeaders(), Cookie: sessionCookie },
    timeout: 120_000,
    validateStatus: () => true,
  });

  if (response.status !== 200 || !response.data?.success) {
    throw new Error(
      `Import de contatos falhou: HTTP ${response.status} — ${response.data?.error ?? "resposta inesperada"}`
    );
  }
  console.log(`[test-queue] Import OK:`, response.data.results);
}

// Canal WAHA descartável — ver comentário no topo do arquivo para o
// raciocínio completo. habilitado=false mantém ele fora de qualquer
// fluxo de envio de campanha real que liste canais habilitados; o
// waha_url num TLD .invalid garante que nenhuma requisição de rede
// chegue a um destino de verdade.
async function createTestChannel(): Promise<string> {
  const db = supabaseAdmin();
  const suffix = randomUUID();

  const { data, error } = await db
    .from("whatsapp_config")
    .insert({
      user_id: USER_ID(),
      account_id: ACCOUNT_ID(),
      provider: "waha",
      phone_number_id: `${STRESS_PREFIX}_${suffix}`,
      display_phone_number: `${STRESS_PREFIX}_${suffix}`,
      access_token: `${STRESS_PREFIX}_unused_waha_provider`,
      status: "disconnected",
      habilitado: false,
      receptivo: false,
      waha_url: "https://stress-test-invalid.example.invalid",
      waha_session: `${STRESS_PREFIX}_${suffix}`,
      waha_api_key: null,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`Falha ao criar canal de teste: ${error?.message}`);
  }
  console.log(`[test-queue] Canal de teste criado: ${data.id}`);
  return data.id;
}

async function deleteTestChannel(channelId: string): Promise<void> {
  const db = supabaseAdmin();
  const { error } = await db.from("whatsapp_config").delete().eq("id", channelId);
  if (error) {
    console.error(`[test-queue] Falha ao remover canal de teste ${channelId} (cleanup.ts pega depois):`, error.message);
  } else {
    console.log(`[test-queue] Canal de teste ${channelId} removido.`);
  }
}

async function createTestCampaign(channelId: string): Promise<string> {
  const db = supabaseAdmin();

  const { data, error } = await db
    .from("campaigns")
    .insert({
      nome: `${STRESS_PREFIX}_queue_${Date.now()}`,
      objetivo: "Stress test — não enviar de verdade",
      status: "rascunho",
      account_id: ACCOUNT_ID(),
      created_by: USER_ID(),
      session_ids: [channelId],
      tags_filtro: [STRESS_PREFIX],
      mensagens: [{ tipo: "texto", conteudo: `${STRESS_PREFIX} — mensagem de carga` }],
      intervalo_min: 0,
      intervalo_max: 1,
      // batch_size alto agrupa itens no mesmo scheduled_at (ver
      // startCampaign.ts) para o cron poder puxar um lote grande por
      // tick em vez do pacing sequencial de intervalo_min/max — é isso
      // que revela o throughput real do cron.
      batch_size: 100,
      batch_pause_seconds: 0,
      // Valores EXATOS que cron/route.ts trata como "sem janela" — ver
      // `hasWindow` em src/app/api/disparador/cron/route.ts.
      janela_inicio: "00:00",
      janela_fim: "23:59",
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`Falha ao criar campanha de teste: ${error?.message}`);
  }
  console.log(`[test-queue] Campanha criada: ${data.id}`);
  return data.id;
}

async function startCampaign(campaignId: string, sessionCookie: string): Promise<number> {
  const response = await axios.post(
    `${TARGET_URL}/api/disparador/campaigns/${campaignId}/start`,
    {},
    { headers: { Cookie: sessionCookie }, timeout: 60_000, validateStatus: () => true }
  );
  if (response.status !== 200 || !response.data?.success) {
    throw new Error(
      `Falha ao iniciar campanha: HTTP ${response.status} — ${response.data?.error ?? "resposta inesperada"}`
    );
  }
  console.log(`[test-queue] Campanha iniciada — ${response.data.enqueued} itens enfileirados.`);
  return response.data.enqueued as number;
}

async function pollQueue(campaignId: string, startedAt: number): Promise<PollSnapshot[]> {
  const db = supabaseAdmin();
  const snapshots: PollSnapshot[] = [];

  while (true) {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > QUEUE_TEST_TIMEOUT_MS) {
      console.log(`[test-queue] Timeout de ${QUEUE_TEST_TIMEOUT_MS / 60_000}min atingido — parando polling.`);
      break;
    }

    const { data, error } = await db
      .from("disp_message_queue")
      .select("status")
      .eq("campaign_id", campaignId);

    if (error) {
      console.error(`[test-queue] Erro ao consultar fila:`, error.message);
      await sleep(QUEUE_POLL_INTERVAL_MS);
      continue;
    }

    const counts: Record<string, number> = {};
    for (const status of QUEUE_STATUSES) counts[status] = 0;
    for (const row of data ?? []) {
      counts[row.status] = (counts[row.status] ?? 0) + 1;
    }
    const total = (data ?? []).length;
    const inFlight = (counts.agendado ?? 0) + (counts.enviando ?? 0) + (counts.pendente ?? 0);

    const snapshot: PollSnapshot = { atMs: Date.now(), elapsedMs, counts, total, inFlight };
    snapshots.push(snapshot);

    console.log(
      `[test-queue] t=${(elapsedMs / 1000).toFixed(0)}s — ` +
        QUEUE_STATUSES.map((s) => `${s}=${counts[s]}`).join(" ")
    );

    if (total > 0 && inFlight === 0) {
      console.log(`[test-queue] Fila drenada — nenhum item agendado/enviando/pendente restante.`);
      break;
    }

    await sleep(QUEUE_POLL_INTERVAL_MS);
  }

  return snapshots;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeThroughput(snapshots: PollSnapshot[]): {
  itemsPerMinute: number[];
  avgItemsPerMinute: number;
} {
  const itemsPerMinute: number[] = [];
  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1];
    const curr = snapshots[i];
    const prevProcessed = prev.total - prev.inFlight;
    const currProcessed = curr.total - curr.inFlight;
    const deltaItems = currProcessed - prevProcessed;
    const deltaMinutes = (curr.atMs - prev.atMs) / 60_000;
    itemsPerMinute.push(deltaMinutes > 0 ? deltaItems / deltaMinutes : 0);
  }
  const avg =
    itemsPerMinute.length > 0
      ? itemsPerMinute.reduce((a, b) => a + b, 0) / itemsPerMinute.length
      : 0;
  return { itemsPerMinute, avgItemsPerMinute: avg };
}

async function main() {
  const sessionCookie = SESSION_TOKEN();
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  await importTestContacts(sessionCookie);
  const channelId = await createTestChannel();
  let campaignId: string;
  try {
    campaignId = await createTestCampaign(channelId);
  } catch (err) {
    await deleteTestChannel(channelId);
    throw err;
  }
  const startedAt = Date.now();
  const enqueued = await startCampaign(campaignId, sessionCookie);

  const snapshots = await pollQueue(campaignId, startedAt);
  await deleteTestChannel(channelId);
  const { itemsPerMinute, avgItemsPerMinute } = computeThroughput(snapshots);

  const last = snapshots[snapshots.length - 1];
  const drained = !!last && last.total > 0 && last.inFlight === 0;

  const result = {
    campaignId,
    enqueued,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    totalDurationMs: Date.now() - startedAt,
    drained,
    finalCounts: last?.counts ?? {},
    throughputItemsPerMinute: itemsPerMinute,
    avgThroughputItemsPerMinute: Math.round(avgItemsPerMinute * 100) / 100,
    snapshots,
    note:
      "Latência por item não é medida com precisão de ms — disp_message_queue.updated_at " +
      "não é mantida por trigger (ver migration notes) e itens de erro não setam sent_at. " +
      "O throughput acima é derivado da granularidade do polling (30s).",
  };

  const outPath = path.join(RESULTS_DIR, "queue-results.json");
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf-8");

  console.log(`\n[test-queue] Resumo:`);
  console.log(`  Enfileirados: ${enqueued}`);
  console.log(`  Drenou: ${drained ? "sim" : "não (timeout)"}`);
  console.log(`  Throughput médio: ${result.avgThroughputItemsPerMinute} itens/min`);
  console.log(`  Contagem final: ${JSON.stringify(result.finalCounts)}`);
  console.log(`[test-queue] Resultados salvos em ${outPath}`);
}

main().catch((err) => {
  console.error("[test-queue] Erro fatal:", err.message);
  process.exit(1);
});

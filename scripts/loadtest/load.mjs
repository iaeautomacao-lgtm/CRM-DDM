// Roteiro de carga do disparador contra a Meta SIMULADA (docs/disparador-bancada-carga.md). Cenários S3/S4 do audit; veja o doc para S0–S11.
//
//   npx tsx scripts/loadtest/load.mjs              # cria canais/template/campanhas, roda o cron em loop e imprime o relatório
//   npx tsx scripts/loadtest/load.mjs --setup-only
//   npx tsx scripts/loadtest/load.mjs --cleanup LOAD<runId>   # apaga o que uma execução criou
//
// SEGURANÇA: só roda contra um Supabase de TESTE (recusa o de produção) e um app em localhost/rede privada
// (ou LOAD_ALLOW_REMOTE_APP=true p/ o staging). O app em teste precisa de DISPATCH_LOAD_TEST=1 + META_API_BASE_URL → scripts/loadtest/mock-meta.mjs.
// Nunca use com canais/tokens reais. Variáveis: veja assertSafeLoadTarget em scripts/lib/load-metrics.mjs.
// (tsx porque importa o encrypt() do app: ENCRYPTION_KEY precisa ser a MESMA do app em teste.)

import { createClient } from '@supabase/supabase-js';
import { existsSync, readFileSync } from 'node:fs';
import { assertSafeLoadTarget, formatTable, summarizeMock, summarizeTicks } from './lib/load-metrics.mjs';

// Carrega .env.load (se existir) SEM sobrescrever o ambiente — de propósito não lê o .env do app.
if (existsSync('.env.load')) {
  for (const line of readFileSync('.env.load', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);

async function main() {
  const cfg = assertSafeLoadTarget(process.env);
  const db = createClient(cfg.supabaseUrl, cfg.serviceRoleKey, { db: { schema: 'wacrm' }, auth: { persistSession: false } });

  if (args[0] === '--cleanup') return cleanup(db, cfg, args[1]);

  const { encrypt } = await import('../../src/lib/whatsapp/encryption.ts');
  const runId = `LOAD${Date.now().toString(36).toUpperCase()}`;
  console.log(`[load] execução ${runId}: ${cfg.channels} canais × ${cfg.campaignsPerChannel} campanha(s) × ${cfg.itemsPerCampaign} itens`);
  console.log('[load] ⚠️  O app em teste deve estar com DISPATCH_LOAD_TEST=1 e META_API_BASE_URL → Meta simulada. Nada será enviado ao WhatsApp.');

  // 1) Canais fictícios + template aprovado na WABA fictícia.
  const wabaId = `${runId}_waba`;
  const templateName = `load_${runId.toLowerCase()}`;
  const channelRows = Array.from({ length: cfg.channels }, (_, i) => ({
    user_id: cfg.userId,
    account_id: cfg.accountId,
    provider: 'meta',
    phone_number_id: `${runId}_${i + 1}`,
    waba_id: wabaId,
    access_token: encrypt('token-fictício-da-bancada'),
    app_secret: encrypt(process.env.LOAD_APP_SECRET ?? 'mock-app-secret'),
    display_phone_number: `+55 11 90000-${String(1000 + i)}`,
    status: 'connected',
    habilitado: true,
  }));
  const { data: channels, error: channelError } = await db.from('whatsapp_config').insert(channelRows).select('id, phone_number_id');
  if (channelError) throw new Error(`Falha ao criar canais fictícios: ${channelError.message}\n(adapte as colunas ao schema do seu banco de teste)`);
  const { error: templateError } = await db.from('message_templates').insert({
    user_id: cfg.userId,
    account_id: cfg.accountId,
    name: templateName,
    category: 'Utility',
    language: 'pt_BR',
    body_text: 'Olá {{1}}, esta é uma mensagem de teste de carga.',
    status: 'APPROVED',
    waba_id: wabaId,
  });
  if (templateError) throw new Error(`Falha ao criar o template fictício: ${templateError.message}`);

  // 2) Campanhas pela API pública (mesmo caminho das integrações): janela 24h/7 dias, tudo vencido já.
  if (!cfg.apiKey) throw new Error('LOAD_API_KEY (chave da conta de teste com campaigns:write) é necessária para criar as campanhas.');
  const campaignIds = [];
  let phoneSeq = 0;
  for (const channel of channels) {
    for (let c = 0; c < cfg.campaignsPerChannel; c++) {
      const contacts = Array.from({ length: cfg.itemsPerCampaign }, () => {
        phoneSeq++;
        return { phone: `55119${String(10_000_000 + phoneSeq).slice(-8)}`, variables: [`Cliente ${phoneSeq}`] };
      });
      const res = await fetch(`${cfg.appUrl}/api/v1/disparador/campaigns`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `${runId}-${channel.id}-${c}` },
        body: JSON.stringify({
          campaign_name: `LOADTEST-${runId}-${channel.phone_number_id}-${c + 1}`,
          channel: channel.id,
          template_name: templateName,
          template_language: 'pt_BR',
          janela_inicio: '00:00',
          janela_fim: '23:59',
          dias_envio: [0, 1, 2, 3, 4, 5, 6],
          slot_size: cfg.itemsPerCampaign,
          slot_interval_minutes: 1,
          contacts,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Campanha recusada (${res.status}): ${JSON.stringify(body)}`);
      campaignIds.push(body.data.campaign_id);
      console.log(`[load] campanha ${body.data.campaign_id} no canal ${channel.phone_number_id}: ${body.data.enqueued} itens`);
    }
  }
  if (args.includes('--setup-only')) {
    console.log(`[load] preparado. Para limpar: npx tsx scripts/loadtest/load.mjs --cleanup ${runId}`);
    return;
  }

  // 3) Carga: cron em loop + amostragem da Meta simulada a cada 1 s.
  const startedAt = new Date();
  const mockSamples = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      try {
        const res = await fetch(`${cfg.mockStatsUrl}/__stats`);
        if (res.ok) mockSamples.push({ at: Date.now(), snapshot: await res.json() });
      } catch {
        /* mock fora do ar: segue */
      }
      await sleep(1000);
    }
  })();

  const tickHttpMs = [];
  const tickStatus = {};
  const deadline = Date.now() + cfg.durationS * 1000;
  let pending = Infinity;
  while (Date.now() < deadline && pending > 0) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${cfg.appUrl}/api/disparador/cron`, { method: 'POST', headers: { 'x-cron-secret': cfg.cronSecret } });
      tickHttpMs.push(Date.now() - t0);
      tickStatus[res.status] = (tickStatus[res.status] ?? 0) + 1;
      await res.text().catch(() => '');
    } catch (err) {
      tickStatus.erro_de_rede = (tickStatus.erro_de_rede ?? 0) + 1;
      console.error('[load] falha no tick:', err instanceof Error ? err.message : err);
    }
    const { count } = await db
      .from('disp_message_queue')
      .select('id', { count: 'exact', head: true })
      .in('campaign_id', campaignIds)
      .in('status', ['agendado', 'pendente', 'enviando']);
    pending = count ?? 0;
    process.stdout.write(`\r[load] ${Math.round((Date.now() - startedAt.getTime()) / 1000)}s  pendentes=${pending}   `);
    if (cfg.tickIntervalMs) await sleep(cfg.tickIntervalMs);
  }
  sampling = false;
  await sampler;
  console.log('');

  // 4) Relatório.
  const { data: logRows, error: logError } = await db
    .from('system_logs')
    .select('created_at, payload')
    .eq('source', 'disparador')
    .eq('event', 'cron_tick')
    .gte('created_at', startedAt.toISOString())
    .order('created_at', { ascending: true })
    .limit(10_000);
  if (logError) console.error('[load] não foi possível ler system_logs:', logError.message);
  const ticks = summarizeTicks(logRows ?? []);
  const mock = summarizeMock(mockSamples);

  console.log('\n== Envios por número (Meta simulada) ==');
  console.log(
    formatTable(
      ['phone_number_id', 'requisições', 'média/s', 'pico/s', 'máx em voo', 'erros'],
      Object.entries(mock.phones).map(([id, p]) => [id, p.requests, p.avgRps, p.peakRps, p.maxInFlight, Object.entries(p.errors).map(([k, v]) => `${k}:${v}`).join(' ') || '-']),
    ),
  );
  console.log(`total: ${mock.totalRequests} requisições em ${mock.elapsedS}s = ${mock.totalAvgRps}/s (meta: 80/s por número)`);

  console.log('\n== Tick do cron ==');
  console.log(
    formatTable(
      ['métrica', 'valor'],
      [
        ['ticks (cron_tick)', ticks.ticks],
        ['duração do tick p50 / p95 / máx (ms)', `${ticks.tickP50Ms} / ${ticks.tickP95Ms} / ${ticks.tickMaxMs}`],
        ['resposta HTTP do cron p50 / p95 (ms)', `${percentileOf(tickHttpMs, 50)} / ${percentileOf(tickHttpMs, 95)}`],
        ['HTTP do cron por status', JSON.stringify(tickStatus)],
        ['enviados / falhas (soma dos ticks)', `${ticks.sentTotal} / ${ticks.failedTotal}`],
        ['em voo (pico global)', ticks.peakInFlight],
        ['lag do event loop p99 (máx, ms)', ticks.lagP99MaxMs],
        ['RSS pico (MB)', ticks.rssPeakMb],
        ['eventos de backoff', ticks.backoffEvents],
        ['erros do provedor', JSON.stringify(ticks.providerErrors)],
      ],
    ),
  );
  const { data: statusRows } = await db.from('disp_message_queue').select('status').in('campaign_id', campaignIds).limit(100_000);
  const byStatus = {};
  for (const r of statusRows ?? []) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  console.log(`\nfila final: ${JSON.stringify(byStatus)}`);
  console.log('\nIdas ao banco por envio: rode no SQL do projeto de TESTE, antes e depois da carga,');
  console.log("  SELECT sum(calls) FROM pg_stat_statements;   -- (delta) / envios = idas por envio");
  console.log(`\nLimpeza: npx tsx scripts/loadtest/load.mjs --cleanup ${runId}`);
}

function percentileOf(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

async function cleanup(db, cfg, runId) {
  if (!runId || !/^LOAD[A-Z0-9]+$/.test(runId)) throw new Error('Informe o id da execução (ex.: LOADMABC123).');
  const { data: campaigns } = await db.from('campaigns').select('id').eq('account_id', cfg.accountId).like('nome', `LOADTEST-${runId}-%`);
  const ids = (campaigns ?? []).map((c) => c.id);
  for (let i = 0; i < ids.length; i += 50) {
    const slice = ids.slice(i, i + 50);
    await db.from('disp_message_queue').delete().in('campaign_id', slice);
    await db.from('campaign_metrics').delete().in('campaign_id', slice);
    await db.from('campaigns').delete().in('id', slice);
  }
  await db.from('whatsapp_config').delete().eq('account_id', cfg.accountId).like('phone_number_id', `${runId}_%`);
  await db.from('message_templates').delete().eq('account_id', cfg.accountId).eq('waba_id', `${runId}_waba`);
  console.log(`[load] limpeza de ${runId}: ${ids.length} campanha(s) removida(s), canais e template fictícios apagados.`);
}

main().catch((err) => {
  console.error('[load] ERRO:', err instanceof Error ? err.message : err);
  process.exit(1);
});

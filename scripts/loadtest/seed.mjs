// Volume realista para a bancada de carga (audit §4): 100k contatos, blacklist de 50k e 3M de linhas históricas na
// fila (índices e tabelas com o tamanho de produção). Só roda contra um Supabase de TESTE (recusa a produção).
//
//   npx tsx scripts/loadtest/seed.mjs                      # padrão: 100k contatos, 50k blacklist, 3M histórico
//   npx tsx scripts/loadtest/seed.mjs --contacts 20000 --blacklist 5000 --history 500000
//   npx tsx scripts/loadtest/seed.mjs --cleanup            # apaga tudo que o seed criou (marcado por prefixo)
//
// Variáveis: as mesmas de load.mjs (LOAD_SUPABASE_URL, LOAD_SUPABASE_SERVICE_ROLE_KEY, LOAD_ACCOUNT_ID, LOAD_USER_ID,
// LOAD_CONFIRM_TEST_DB=yes …; LOAD_APP_URL/LOAD_CRON_SECRET não são usadas aqui, mas a validação é a mesma).
// Telefones fictícios: faixa 55 11 9 5xxxxxxx (contatos) e 55 11 9 6xxxxxxx (blacklist) — nunca colidem com load.mjs (9 1xxxxxxx).
// O histórico é da campanha "LOADSEED-histórico" (encerrada); linhas já entregues/lidas/com erro, sem agenda futura.

import { createClient } from '@supabase/supabase-js';
import { existsSync, readFileSync } from 'node:fs';
import { assertSafeLoadTarget, formatTable } from './lib/load-metrics.mjs';

if (existsSync('.env.load')) {
  for (const line of readFileSync('.env.load', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  const n = i >= 0 ? Number.parseInt(args[i + 1] ?? '', 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
const BATCH = 1000;
const CONCURRENCY = 4;
const SEED_TAG = 'LOADSEED';
const CAMPAIGN_NAME = `${SEED_TAG}-histórico`;

/** Telefones determinísticos (sem colisão entre faixas). */
export const seedPhone = (kind, i) => `55119${kind === 'blacklist' ? 6 : 5}${String(i).padStart(7, '0').slice(-7)}`;

async function inBatches(total, label, makeRows, insert) {
  let done = 0;
  const started = Date.now();
  const batches = Math.ceil(total / BATCH);
  let next = 0;
  async function worker() {
    while (next < batches) {
      const b = next++;
      const from = b * BATCH;
      const rows = makeRows(from, Math.min(total, from + BATCH));
      const { error } = await insert(rows);
      if (error) throw new Error(`${label}: ${error.message}\n(adapte as colunas ao schema do seu banco de teste)`);
      done += rows.length;
      if (b % 20 === 0) process.stdout.write(`\r[seed] ${label}: ${done}/${total}   `);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stdout.write(`\r[seed] ${label}: ${done}/${total} em ${Math.round((Date.now() - started) / 1000)}s\n`);
  return done;
}

async function main() {
  const cfg = assertSafeLoadTarget(process.env);
  const db = createClient(cfg.supabaseUrl, cfg.serviceRoleKey, { db: { schema: 'wacrm' }, auth: { persistSession: false } });

  if (args.includes('--cleanup')) {
    const { data: camps } = await db.from('campaigns').select('id').eq('account_id', cfg.accountId).eq('nome', CAMPAIGN_NAME);
    for (const c of camps ?? []) {
      // Apaga a fila em fatias (a tabela é grande).
      for (;;) {
        const { data: ids } = await db.from('disp_message_queue').select('id').eq('campaign_id', c.id).limit(5000);
        if (!ids?.length) break;
        await db.from('disp_message_queue').delete().in('id', ids.map((r) => r.id));
      }
      await db.from('campaigns').delete().eq('id', c.id);
    }
    await db.from('contacts').delete().eq('account_id', cfg.accountId).like('name', `${SEED_TAG} %`);
    await db.from('blacklist').delete().eq('account_id', cfg.accountId).eq('bloqueado_por', SEED_TAG);
    console.log('[seed] limpeza concluída.');
    return;
  }

  const nContacts = arg('contacts', 100_000);
  const nBlacklist = arg('blacklist', 50_000);
  const nHistory = arg('history', 3_000_000);
  console.log(`[seed] ${nContacts} contatos, ${nBlacklist} na blacklist, ${nHistory} linhas históricas (Supabase de TESTE ${cfg.supabaseUrl})`);

  await inBatches(
    nContacts,
    'contatos',
    (a, b) => Array.from({ length: b - a }, (_, k) => ({ user_id: cfg.userId, account_id: cfg.accountId, phone: `+${seedPhone('contact', a + k)}`, name: `${SEED_TAG} ${a + k}` })),
    (rows) => db.from('contacts').insert(rows),
  );
  await inBatches(
    nBlacklist,
    'blacklist',
    (a, b) => Array.from({ length: b - a }, (_, k) => ({ telefone: seedPhone('blacklist', a + k), motivo: 'carga', bloqueado_por: SEED_TAG, account_id: cfg.accountId })),
    (rows) => db.from('blacklist').insert(rows),
  );

  if (nHistory > 0) {
    const { data: campaign, error } = await db
      .from('campaigns')
      .insert({ nome: CAMPAIGN_NAME, status: 'encerrada', account_id: cfg.accountId, created_by: cfg.userId })
      .select('id')
      .single();
    if (error) throw new Error(`campanha de histórico: ${error.message}\n(adapte as colunas ao schema do seu banco de teste)`);
    const statuses = ['entregue', 'lido', 'entregue', 'erro'];
    const past = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    await inBatches(
      nHistory,
      'fila histórica',
      (a, b) =>
        Array.from({ length: b - a }, (_, k) => ({
          campaign_id: campaign.id,
          account_id: cfg.accountId,
          contact_id: null,
          session_id: null,
          mensagem_final: seedPhone('contact', (a + k) % Math.max(nContacts, 1)),
          status: statuses[(a + k) % statuses.length],
          tipo: 'texto',
          scheduled_at: past,
          sent_at: past,
        })),
      (rows) => db.from('disp_message_queue').insert(rows),
    );
  }

  console.log(formatTable(['item', 'quantidade'], [['contatos', nContacts], ['blacklist', nBlacklist], ['fila histórica', nHistory]]));
  console.log('[seed] pronto. Limpeza: npx tsx scripts/loadtest/seed.mjs --cleanup');
}

main().catch((err) => {
  console.error('[seed] ERRO:', err instanceof Error ? err.message : err);
  process.exit(1);
});

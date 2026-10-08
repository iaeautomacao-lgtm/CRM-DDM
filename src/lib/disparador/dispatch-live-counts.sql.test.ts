// Migration 198 (A20/A21): os painéis leem agregados em vez de varrer a fila — com OS MESMOS NÚMEROS de antes.
// PGlite com a 198 real + get_campaign_stats real (075): o cálculo antigo (as consultas count-exact do endpoint e do
// detalhamento) é comparado com o novo numa massa sintética (várias contas, campanhas, números, status e horários).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadLiveCountsViaRpc } from './live-performance';
import { totalFromStatusCounts } from './queue-total';
import { QUEUE_DETAIL_STATUS_FILTERS } from './queue-status-filters';

const A = 'a0000000-0000-0000-0000-000000000001';
const B = 'b0000000-0000-0000-0000-000000000002';
const uid = (p: string, n: number) => `${p}0000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const STATUSES = ['agendado', 'pendente', 'pausado', 'enviando', 'enviado', 'entregue', 'lido', 'erro', 'bloqueado', 'cancelado'];
let db: PGlite;

// Ponte rpc → PGlite (a mesma chamada do app).
const rpcDb = {
  rpc: async (fn: string, args: Record<string, unknown> = {}) => {
    try {
      const placeholders = Object.keys(args).map((k, i) => `${k} => $${i + 1}`).join(', ');
      const res = await db.query<{ r: unknown }>(`SELECT to_jsonb(x) AS r FROM (SELECT * FROM wacrm.${fn}(${placeholders})) x`, Object.values(args));
      if (fn === 'get_campaign_stats') return { data: res.rows.map((r) => r.r), error: null };
      return { data: (res.rows[0]?.r as Record<string, unknown>)[fn], error: null };
    } catch (e) {
      return { data: null, error: { message: (e as Error).message } };
    }
  },
  from: () => {
    throw new Error('o caminho com count exato não deveria ser usado');
  },
};

/** O cálculo ANTIGO do endpoint live: cinco `count: exact` com os mesmos predicados. */
async function oldLive(account: string) {
  const one = async (sql: string, p: unknown[]) => Number((await db.query<{ n: string }>(sql, p)).rows[0].n);
  const camps = `(SELECT id FROM wacrm.campaigns WHERE account_id = $1 AND status = 'em_execucao')`;
  const chans = `(SELECT id FROM wacrm.whatsapp_config WHERE account_id = $1 AND habilitado = true)`;
  const q = (statuses: string) =>
    one(`SELECT count(*) AS n FROM wacrm.disp_message_queue WHERE campaign_id IN ${camps} AND status IN (${statuses})`, [account]);
  return {
    activeCampaigns: await one(`SELECT count(*) AS n FROM wacrm.campaigns WHERE account_id = $1 AND status = 'em_execucao'`, [account]),
    queued: await q(`'agendado','pendente','pausado'`),
    sending: await q(`'enviando'`),
    errors: await q(`'erro'`),
    blocked: await q(`'bloqueado'`),
    sentLast60s: await one(
      `SELECT count(*) AS n FROM wacrm.disp_message_queue WHERE session_id IN ${chans} AND sent_at >= now() - interval '60 seconds'`,
      [account],
    ),
  };
}

describe('migration 198 — painéis com os mesmos números', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA wacrm;
      CREATE TABLE wacrm.campaigns (id uuid PRIMARY KEY, account_id uuid, status text);
      CREATE TABLE wacrm.whatsapp_config (id uuid PRIMARY KEY, account_id uuid, habilitado boolean DEFAULT true);
      CREATE TABLE wacrm.disp_message_queue (id uuid PRIMARY KEY, campaign_id uuid, session_id uuid, status text, sent_at timestamptz);
    `);
    const get = readFileSync(resolve(process.cwd(), 'supabase/migrations/075_disparador_improvements.sql'), 'utf8').match(
      /CREATE OR REPLACE FUNCTION wacrm\.get_campaign_stats[\s\S]*?\$\$;/,
    )![0];
    await db.exec(get);
    const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/198_dispatch_live_counts.sql'), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '');
    await db.exec(sql);
    await db.exec(sql); // idempotente

    // Massa: conta A (2 campanhas em execução, 1 pausada, 2 números + 1 desabilitado), conta B (1 campanha, 1 número).
    await db.exec(`
      INSERT INTO wacrm.campaigns VALUES ('${uid('c', 1)}','${A}','em_execucao'), ('${uid('c', 2)}','${A}','em_execucao'), ('${uid('c', 3)}','${A}','pausada'), ('${uid('c', 4)}','${B}','em_execucao');
      INSERT INTO wacrm.whatsapp_config VALUES ('${uid('d', 1)}','${A}',true), ('${uid('d', 2)}','${A}',true), ('${uid('d', 3)}','${A}',false), ('${uid('d', 4)}','${B}',true);
    `);
    let n = 0;
    const camps = [uid('c', 1), uid('c', 2), uid('c', 3), uid('c', 4)];
    const sess = [uid('d', 1), uid('d', 2), uid('d', 3), uid('d', 4)];
    const rows: string[] = [];
    for (let i = 0; i < 400; i++) {
      const status = STATUSES[(i * 7) % STATUSES.length];
      const campaign = camps[i % 4];
      const session = sess[(i * 3) % 4];
      const sentAgo = ['enviado', 'entregue', 'lido'].includes(status) ? [5, 30, 59, 61, 600, 7200][i % 6] : null;
      rows.push(`('${uid('e', ++n)}','${campaign}','${session}','${status}',${sentAgo === null ? 'NULL' : `now() - interval '${sentAgo} seconds'`})`);
    }
    await db.exec(`INSERT INTO wacrm.disp_message_queue VALUES ${rows.join(',')}`);
  }, 60_000);
  afterAll(async () => {
    await db.close();
  });

  it('live: abaixo do teto os números são IDÊNTICOS aos do cálculo antigo (por conta)', async () => {
    for (const account of [A, B]) {
      const old = await oldLive(account);
      const fast = await loadLiveCountsViaRpc(rpcDb as never, account);
      expect(fast).not.toBeNull();
      expect(fast!.counts).toEqual(old);
      expect(Object.values(fast!.capped).some(Boolean)).toBe(false);
    }
    // sanidade: a massa exercita os casos (campanha pausada e número desabilitado ficam de fora)
    expect((await oldLive(A)).queued).toBeGreaterThan(10);
    expect((await oldLive(A)).sentLast60s).toBeGreaterThan(3);
  });

  it('live: isolamento — uma conta não enxerga a fila da outra', async () => {
    const none = await loadLiveCountsViaRpc(rpcDb as never, '99999999-0000-0000-0000-000000000009');
    expect(none!.counts).toEqual({ activeCampaigns: 0, queued: 0, sending: 0, errors: 0, blocked: 0, sentLast60s: 0 });
  });

  it('live: o teto limita o custo e AVISA (capped); o valor mostrado é o teto', async () => {
    const res = await rpcDb.rpc('dispatch_live_counts', { p_account_id: A, p_cap: 5 });
    const r = res.data as { queued: number; capped: Record<string, boolean>; cap: number };
    expect(r.cap).toBe(5);
    expect(r.queued).toBe(5);
    expect(r.capped.queued).toBe(true);
  });

  it('total do detalhamento (get_campaign_stats) = count exato com o mesmo filtro, para cada métrica e para "total"', async () => {
    const keys = Object.entries(QUEUE_DETAIL_STATUS_FILTERS).filter(([k]) => k !== 'aguardando_confirmacao' && k !== 'respondido');
    const filters: Array<[string, string[] | null]> = [...keys, ['total', null]];
    for (const campaign of [uid('c', 1), uid('c', 2), uid('c', 3)]) {
      for (const [key, statuses] of filters) {
        const exact = Number(
          (
            await db.query<{ n: string }>(
              `SELECT count(*) AS n FROM wacrm.disp_message_queue WHERE campaign_id = $1 ${statuses ? 'AND status = ANY($2)' : ''}`,
              statuses ? [campaign, statuses] : [campaign],
            )
          ).rows[0].n,
        );
        const viaStats = await totalFromStatusCounts(rpcDb as never, campaign, statuses);
        expect(viaStats, `${campaign} ${key}`).toBe(exact);
      }
    }
  });

  it('grants: só service_role executa a função nova', async () => {
    const res = await db.query<{ anon: boolean; auth: boolean; svc: boolean }>(
      `SELECT has_function_privilege('anon','wacrm.dispatch_live_counts(uuid,integer)','EXECUTE') AS anon,
              has_function_privilege('authenticated','wacrm.dispatch_live_counts(uuid,integer)','EXECUTE') AS auth,
              has_function_privilege('service_role','wacrm.dispatch_live_counts(uuid,integer)','EXECUTE') AS svc`,
    );
    expect(res.rows[0]).toEqual({ anon: false, auth: false, svc: true });
  });
});

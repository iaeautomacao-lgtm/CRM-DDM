// Migration 183 (B11): incrementos de métricas viram deltas só-insert + consolidação em lote, e toda
// leitura passa pela view campaign_metrics_live (campaign_metrics + deltas pendentes).
// Inclui o teste de carga local: 10 mil incrementos "concorrentes" numa campanha, antes × depois.
// (PGlite é uma conexão só: mede custo por operação e inchaço, não a fila de lock entre conexões.)

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const account = '00000000-0000-0000-0000-000000000001';
const campaign = '00000000-0000-0000-0000-000000000011';
const campaign2 = '00000000-0000-0000-0000-000000000012';
const ghost = '00000000-0000-0000-0000-0000000000ff';
const N = Number(process.env.METRICS_LOAD_INCREMENTS ?? 10_000);
let db: PGlite;

const MIX = [
  ['total_enviados', 0.5],
  ['total_entregues', 0.3],
  ['total_lidos', 0.15],
  ['total_erros', 0.04],
  ['total_respostas', 0.01],
] as const;
const plan = (n: number) => {
  const out: string[] = [];
  for (const [field, share] of MIX) for (let i = 0; i < Math.round(n * share); i++) out.push(field);
  return out;
};
const expected = (n: number) => Object.fromEntries(MIX.map(([f, s]) => [f, Math.round(n * s)]));

async function runIncrements(c: string, fields: string[]) {
  await Promise.all(fields.map((field) => db.query('SELECT wacrm.increment_campaign_metric($1::uuid, $2)', [c, field])));
}
async function live(c: string) {
  const r = await db.query<Record<string, number>>('SELECT * FROM wacrm.campaign_metrics_live WHERE campaign_id = $1', [c]);
  return r.rows[0];
}
async function base(c: string) {
  const r = await db.query<Record<string, number>>('SELECT * FROM wacrm.campaign_metrics WHERE campaign_id = $1', [c]);
  return r.rows[0];
}
// UPDATEs acumulados na tabela de métricas (cada um é uma tupla morta + lock da mesma linha).
const updates = async () =>
  Number((await db.query<{ s: string }>("SELECT coalesce(max(n_tup_upd), 0) AS s FROM pg_stat_user_tables WHERE relname = 'campaign_metrics'")).rows[0].s);

let before = { ms: 0, updates: 0 };

describe('migration 183 — métricas por deltas', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA wacrm;
      CREATE TABLE wacrm.campaigns (id uuid PRIMARY KEY, account_id uuid, nome text);
      CREATE TABLE wacrm.disp_message_queue (id serial PRIMARY KEY, campaign_id uuid, status text);
      CREATE TABLE wacrm.campaign_metrics (
        campaign_id uuid PRIMARY KEY, account_id uuid, total_contatos int DEFAULT 0,
        total_enviados int DEFAULT 0, total_entregues int DEFAULT 0, total_lidos int DEFAULT 0,
        total_erros int DEFAULT 0, total_blacklist int DEFAULT 0, total_respostas int DEFAULT 0,
        tempo_medio_resposta int DEFAULT 0, updated_at timestamptz DEFAULT now()
      );
      CREATE FUNCTION wacrm.is_account_member(p_account uuid, p_role text DEFAULT 'viewer') RETURNS boolean
        LANGUAGE sql AS $$ SELECT true $$;
      -- Versão ANTERIOR (UPSERT na linha quente), como em produção:
      CREATE FUNCTION wacrm.increment_campaign_metric(p_campaign_id uuid, p_field text) RETURNS void
      LANGUAGE plpgsql AS $$ BEGIN
        INSERT INTO wacrm.campaign_metrics(campaign_id) VALUES (p_campaign_id) ON CONFLICT DO NOTHING;
        EXECUTE format('UPDATE wacrm.campaign_metrics SET %I=%I+1 WHERE campaign_id=$1', p_field, p_field) USING p_campaign_id;
      END $$;
      INSERT INTO wacrm.campaigns VALUES ('${campaign}', '${account}', 'A'), ('${campaign2}', '${account}', 'B');
      INSERT INTO wacrm.campaign_metrics(campaign_id, account_id, total_contatos) VALUES ('${campaign}', '${account}', ${N});
    `);

    // ANTES: N incrementos na mesma linha.
    const t0 = Date.now();
    await runIncrements(campaign, plan(N));
    before = { ms: Date.now() - t0, updates: await updates() };
    expect(await base(campaign)).toMatchObject(expected(N));
    await db.exec(`UPDATE wacrm.campaign_metrics SET total_enviados=0,total_entregues=0,total_lidos=0,total_erros=0,total_respostas=0
                   WHERE campaign_id='${campaign}'`);

    const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/183_campaign_metric_deltas.sql'), 'utf8').replace(
      /NOTIFY pgrst[^;]*;/g,
      ''
    );
    await db.exec('SET check_function_bodies = off');
    await db.exec(sql);
    await db.exec('SET check_function_bodies = on');
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it(`${N} incrementos concorrentes: leitura live exata antes da consolidação, base exata depois, sem perder nem duplicar`, async () => {
    const t0 = Date.now();
    await runIncrements(campaign, plan(N));
    const afterMs = Date.now() - t0;
    const updatesAfterWrites = (await updates()) - before.updates;

    // Antes de consolidar: a linha base nem foi tocada; a view live já mostra tudo.
    expect(await base(campaign)).toMatchObject({ total_enviados: 0, total_entregues: 0 });
    expect(await live(campaign)).toMatchObject(expected(N));

    // Consolidação em lote, com consolidações concorrentes e novos incrementos no meio.
    const extra = plan(1000);
    await Promise.all([
      db.query('SELECT wacrm.consolidate_campaign_metrics($1)', [3000]),
      db.query('SELECT wacrm.consolidate_campaign_metrics($1)', [3000]),
      runIncrements(campaign, extra),
      db.query('SELECT wacrm.consolidate_campaign_metrics($1)', [3000]),
    ]);
    expect(await live(campaign)).toMatchObject(
      Object.fromEntries(Object.entries(expected(N)).map(([f, v]) => [f, v + (expected(1000)[f] ?? 0)]))
    );

    let guard = 0;
    for (;;) {
      const r = await db.query<{ n: number }>('SELECT wacrm.consolidate_campaign_metrics($1) AS n', [3000]);
      if (r.rows[0].n === 0 || ++guard > 50) break;
    }
    const pending = await db.query<{ n: string }>('SELECT count(*) AS n FROM wacrm.campaign_metric_deltas');
    expect(Number(pending.rows[0].n)).toBe(0);
    const final = Object.fromEntries(Object.entries(expected(N)).map(([f, v]) => [f, v + (expected(1000)[f] ?? 0)]));
    expect(await base(campaign)).toMatchObject(final);
    expect(await live(campaign)).toMatchObject(final);

    process.stderr.write(
      `[carga métricas] ${N} incrementos numa campanha (PGlite, 1 conexão)\n` +
        `  antes  (UPSERT/UPDATE na mesma linha): ${before.ms} ms, ${before.updates} UPDATEs na linha de campaign_metrics\n` +
        `  depois (INSERT de delta):              ${afterMs} ms, ${updatesAfterWrites} UPDATEs na linha de campaign_metrics\n`
    );
  }, 120_000);

  it('consolidação cria a linha de métricas que faltava e descarta deltas de campanha apagada', async () => {
    await runIncrements(campaign2, ['total_enviados', 'total_enviados', 'total_erros']);
    expect(await base(campaign2)).toBeUndefined();
    await runIncrements(ghost, ['total_enviados']);
    await db.query('SELECT wacrm.consolidate_campaign_metrics(100)');
    expect(await base(campaign2)).toMatchObject({ total_enviados: 2, total_erros: 1, account_id: account });
    expect(await base(ghost)).toBeUndefined();
    const left = await db.query<{ n: string }>('SELECT count(*) AS n FROM wacrm.campaign_metric_deltas');
    expect(Number(left.rows[0].n)).toBe(0);
  });

  it('recalculate_campaign_metrics continua exato: não conta duas vezes o que já está na fila; respostas ficam', async () => {
    await db.exec(`
      DELETE FROM wacrm.disp_message_queue;
      INSERT INTO wacrm.disp_message_queue(campaign_id, status) VALUES
        ('${campaign2}','enviado'),('${campaign2}','entregue'),('${campaign2}','lido'),('${campaign2}','erro');
    `);
    await runIncrements(campaign2, ['total_enviados', 'total_enviados', 'total_entregues', 'total_respostas', 'total_respostas']);
    await db.query('SELECT wacrm.recalculate_campaign_metrics($1::uuid)', [campaign2]);
    // fila: enviados (enviado+entregue+lido)=3, entregues=2, lidos=1, erros=1; respostas = 2 pendentes (preservadas)
    expect(await live(campaign2)).toMatchObject({ total_enviados: 3, total_entregues: 2, total_lidos: 1, total_erros: 1, total_respostas: 2 });
  });

  it('a view live mantém as demais colunas e roda com os direitos de quem consulta', async () => {
    await db.exec(`UPDATE wacrm.campaign_metrics SET tempo_medio_resposta = 42 WHERE campaign_id = '${campaign}'`);
    expect(await live(campaign)).toMatchObject({ tempo_medio_resposta: 42, total_contatos: N });
    const opts = await db.query<{ reloptions: string[] }>("SELECT reloptions FROM pg_class WHERE relname = 'campaign_metrics_live'");
    expect(opts.rows[0].reloptions).toContain('security_invoker=true');
  });

  it('só service_role executa as funções internas e o navegador não escreve deltas', async () => {
    const r = await db.query<{ a: boolean; b: boolean }>(
      `SELECT has_function_privilege('authenticated', 'wacrm.increment_campaign_metric(uuid,text)', 'EXECUTE') AS a,
              has_function_privilege('service_role', 'wacrm.consolidate_campaign_metrics(integer)', 'EXECUTE') AS b`
    );
    expect(r.rows[0]).toEqual({ a: false, b: true });
    const priv = await db.query<{ i: boolean; s: boolean }>(
      `SELECT has_table_privilege('authenticated', 'wacrm.campaign_metric_deltas', 'INSERT') AS i,
              has_table_privilege('authenticated', 'wacrm.campaign_metric_deltas', 'SELECT') AS s`
    );
    expect(priv.rows[0]).toEqual({ i: false, s: true });
  });
});

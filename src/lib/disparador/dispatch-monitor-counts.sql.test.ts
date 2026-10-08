// Migration 189/189b: contagens do Monitor numa ida só, escopadas pela conta, sem varrer a fila.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const A = '00000000-0000-0000-0000-0000000000a1'; // conta
const B = '00000000-0000-0000-0000-0000000000b1'; // OUTRA conta
const chA = '00000000-0000-0000-0000-0000000000c1';
const chB = '00000000-0000-0000-0000-0000000000c2';
const campA = '00000000-0000-0000-0000-0000000000d1';
const campB = '00000000-0000-0000-0000-0000000000d2';
let db: PGlite;
const file = (n: string) => readFileSync(resolve(process.cwd(), 'supabase/migrations', n), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '');
let seq = 0;
const id = () => `00000000-0000-0000-0000-${String(2000000 + ++seq).padStart(12, '0')}`;

async function item(opts: { session: string; campaign: string; status: string; sentAgoSec?: number; updatedAgoSec?: number; erro?: string; codigo?: number }) {
  const sent = opts.sentAgoSec !== undefined ? `now() - make_interval(secs => ${Number(opts.sentAgoSec)})` : 'NULL';
  const updated = `now() - make_interval(secs => ${Number(opts.updatedAgoSec ?? 0)})`;
  await db.query(
    `INSERT INTO wacrm.disp_message_queue(id, campaign_id, session_id, status, sent_at, scheduled_at, updated_at, erro, erro_codigo)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text, ${sent}, now(), ${updated}, $5::text, $6::integer)`,
    [id(), opts.campaign, opts.session, opts.status, opts.erro ?? null, opts.codigo ?? null],
  );
}
const counts = async (sessions: string[], campaigns: string[], account = A) =>
  (await db.query<{ r: any }>('SELECT wacrm.dispatch_monitor_counts($1, $2::uuid[], $3::uuid[], 15) AS r', [account, sessions, campaigns])).rows[0].r;

describe('migration 189 — wacrm.dispatch_monitor_counts', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA wacrm;
      CREATE TABLE wacrm.whatsapp_config (id uuid PRIMARY KEY, account_id uuid);
      CREATE TABLE wacrm.campaigns (id uuid PRIMARY KEY, account_id uuid);
      CREATE TABLE wacrm.disp_message_queue (
        id uuid PRIMARY KEY, campaign_id uuid, session_id uuid, status text,
        sent_at timestamptz, scheduled_at timestamptz, updated_at timestamptz DEFAULT now(),
        erro text, erro_codigo integer
      );
      CREATE INDEX ON wacrm.disp_message_queue (session_id, sent_at);
      CREATE INDEX ON wacrm.disp_message_queue (campaign_id, sent_at);
      INSERT INTO wacrm.whatsapp_config VALUES ('${chA}','${A}'), ('${chB}','${B}');
      INSERT INTO wacrm.campaigns VALUES ('${campA}','${A}'), ('${campB}','${B}');
    `);
    await db.exec(file('189_dispatch_monitor_counts.sql'));
    await db.exec(file('189_dispatch_monitor_counts.sql')); // idempotente
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await db.exec('TRUNCATE wacrm.disp_message_queue');
    await db.exec('DROP INDEX IF EXISTS wacrm.idx_dmq_session_agendado');
  });

  it('envios 1/5 min por número e campanha, em voo e erros agrupados por código (15 min)', async () => {
    for (let i = 0; i < 3; i++) await item({ session: chA, campaign: campA, status: 'enviado', sentAgoSec: 20 });
    for (let i = 0; i < 2; i++) await item({ session: chA, campaign: campA, status: 'entregue', sentAgoSec: 200 });
    await item({ session: chA, campaign: campA, status: 'enviado', sentAgoSec: 1000 }); // fora de 5 min
    for (let i = 0; i < 4; i++) await item({ session: chA, campaign: campA, status: 'enviando' });
    for (let i = 0; i < 5; i++) await item({ session: chA, campaign: campA, status: 'erro', erro: '(code 131049)', codigo: 131049, updatedAgoSec: 60 });
    await item({ session: chA, campaign: campA, status: 'erro', erro: 'Contato sem telefone válido', updatedAgoSec: 60 });
    await item({ session: chA, campaign: campA, status: 'erro', erro: '(code 131049)', codigo: 131049, updatedAgoSec: 3600 }); // velho: fora de 15 min
    const r = await counts([chA], [campA]);
    expect(r.sessions).toEqual([{ session_id: chA, sent_1m: 3, sent_5m: 5, in_flight: 4, queued: null }]);
    expect(r.campaigns).toEqual([{ campaign_id: campA, sent_1m: 3, sent_5m: 5 }]);
    const errs = [...r.errors].sort((a: any, b: any) => b.n - a.n);
    expect(errs).toEqual([
      { campaign_id: campA, erro_codigo: 131049, n: 5 },
      { campaign_id: campA, erro_codigo: null, n: 1 },
    ]);
    expect(r.has_error_code).toBe(true);
  });

  it('TENANCY: número e campanha de OUTRA conta pedidos explicitamente não retornam nada', async () => {
    await item({ session: chB, campaign: campB, status: 'enviado', sentAgoSec: 5 });
    await item({ session: chB, campaign: campB, status: 'erro', erro: '(code 131026)', codigo: 131026, updatedAgoSec: 5 });
    const r = await counts([chA, chB], [campA, campB], A);
    expect(r.sessions.map((s: any) => s.session_id)).toEqual([chA]);
    expect(r.campaigns.map((c: any) => c.campaign_id)).toEqual([campA]);
    expect(r.errors).toEqual([]);
    expect(JSON.stringify(r)).not.toContain(chB);
    expect(JSON.stringify(r)).not.toContain(campB);
    // E a conta B enxerga só o que é dela.
    const rb = await counts([chA, chB], [campA, campB], B);
    expect(rb.sessions.map((s: any) => s.session_id)).toEqual([chB]);
    expect(rb.errors).toEqual([{ campaign_id: campB, erro_codigo: 131026, n: 1 }]);
  });

  it('"na fila" por número só é calculado COM o índice da 189b e é limitado a 10.001 linhas', async () => {
    for (let i = 0; i < 25; i++) await item({ session: chA, campaign: campA, status: 'agendado' });
    expect((await counts([chA], [campA])).sessions[0].queued).toBeNull(); // sem índice: nunca varre a fila
    const sql = file('189b_disp_queue_session_agendado_index.sql');
    expect(sql).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dmq_session_agendado/);
    expect(sql).not.toMatch(/^\s*BEGIN\s*;/im);
    await db.exec(sql);
    await db.exec(sql);
    const r = await counts([chA], [campA]);
    expect(r.has_queue_index).toBe(true);
    expect(r.sessions[0].queued).toBe(25);
    const def = (await db.query<{ d: string }>("SELECT pg_get_functiondef('wacrm.dispatch_monitor_counts(uuid, uuid[], uuid[], integer)'::regprocedure) AS d")).rows[0].d;
    expect(def).toContain('LIMIT 10001');
  });

  it('sem a coluna erro_codigo (187 não aplicada): erros vêm agrupados sem código', async () => {
    await db.exec('ALTER TABLE wacrm.disp_message_queue RENAME COLUMN erro_codigo TO erro_codigo_old');
    try {
      await db.query(`INSERT INTO wacrm.disp_message_queue(id, campaign_id, session_id, status, updated_at, erro) VALUES ($1,$2,$3,'erro', now(), 'x')`, [id(), campA, chA]);
      const r = await counts([chA], [campA]);
      expect(r.has_error_code).toBe(false);
      expect(r.errors).toEqual([{ campaign_id: campA, erro_codigo: null, n: 1 }]);
    } finally {
      await db.exec('ALTER TABLE wacrm.disp_message_queue RENAME COLUMN erro_codigo_old TO erro_codigo');
    }
  });

  it('só service_role executa', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${role}`);
      try {
        await expect(db.query("SELECT wacrm.dispatch_monitor_counts(NULL, NULL, NULL, 15)")).rejects.toThrow(/permission denied/);
      } finally {
        await db.exec('RESET ROLE');
      }
    }
  });
});

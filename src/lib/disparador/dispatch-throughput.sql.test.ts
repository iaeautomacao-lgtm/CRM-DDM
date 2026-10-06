import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const campaign = '00000000-0000-0000-0000-000000000011';
const channel = '00000000-0000-0000-0000-000000000021';
const id = (n: number) => `00000000-0000-0000-0000-0000000001${String(n).padStart(2, '0')}`;
let db: PGlite;

async function claim(item: string, fallback: number | null) {
  const result = await db.query<{ ok: boolean }>(
    'SELECT wacrm.claim_dispatch_item_capped($1::uuid, $2::int) AS ok',
    [item, fallback]
  );
  return result.rows[0].ok;
}

describe('migration 164 — vazão do disparador', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA wacrm;
      CREATE TABLE wacrm.whatsapp_config (id uuid PRIMARY KEY);
      CREATE TABLE wacrm.campaigns (id uuid PRIMARY KEY, status text, limite_por_hora int);
      CREATE TABLE wacrm.disp_message_queue (
        id uuid PRIMARY KEY, campaign_id uuid, session_id uuid, status text,
        scheduled_at timestamptz, updated_at timestamptz, sent_at timestamptz, waha_message_id text
      );
      CREATE TABLE wacrm.dispatch_channel_limits (
        session_id uuid PRIMARY KEY, max_in_flight integer NOT NULL DEFAULT 4, hourly_limit integer
      );
      INSERT INTO wacrm.whatsapp_config VALUES ('${channel}');
    `);
    const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/164_dispatch_throughput.sql'), 'utf8')
      .replace(/NOTIFY pgrst[^;]*;/g, '');
    await db.exec(sql);
    // Idempotente.
    await db.exec(sql);
  }, 60_000);
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    const values = Array.from({ length: 8 }, (_, i) => `('${id(i + 1)}','${campaign}','${channel}','agendado',now() - interval '1 minute')`);
    await db.exec(`
      TRUNCATE wacrm.disp_message_queue, wacrm.dispatch_channel_limits, wacrm.dispatch_channel_cooldowns;
      DELETE FROM wacrm.campaigns;
      INSERT INTO wacrm.campaigns VALUES ('${campaign}', 'em_execucao', NULL);
      INSERT INTO wacrm.disp_message_queue(id,campaign_id,session_id,status,scheduled_at) VALUES ${values.join(',')};
    `);
  });

  it('sem linha do canal, usa o padrão do app como teto atômico', async () => {
    const results = [];
    for (let n = 1; n <= 7; n++) results.push(await claim(id(n), 6));
    expect(results).toEqual([true, true, true, true, true, true, false]);
  });

  it('padrão nulo ou fora da faixa volta a 4 (igual ao claim_dispatch_item)', async () => {
    const nulls = [];
    for (let n = 1; n <= 5; n++) nulls.push(await claim(id(n), null));
    expect(nulls).toEqual([true, true, true, true, false]);
    await db.exec(`UPDATE wacrm.disp_message_queue SET status='agendado'`);
    const invalid = [];
    for (let n = 1; n <= 5; n++) invalid.push(await claim(id(n), 999));
    expect(invalid).toEqual([true, true, true, true, false]);
  });

  it('linha de dispatch_channel_limits continua mandando', async () => {
    await db.exec(`INSERT INTO wacrm.dispatch_channel_limits VALUES ('${channel}', 2, NULL)`);
    const results = [];
    for (let n = 1; n <= 3; n++) results.push(await claim(id(n), 10));
    expect(results).toEqual([true, true, false]);
  });

  it('mantém as demais travas: só um claim por item e campanha precisa estar em execução', async () => {
    expect(await claim(id(1), 8)).toBe(true);
    expect(await claim(id(1), 8)).toBe(false);
    await db.exec(`UPDATE wacrm.campaigns SET status='pausada'`);
    expect(await claim(id(2), 8)).toBe(false);
  });

  it('cooldown por canal e view de envios por minuto', async () => {
    await db.exec(`
      INSERT INTO wacrm.dispatch_channel_cooldowns(session_id, cooldown_until, reason)
      VALUES ('${channel}', now() + interval '5 minutes', 'rate_limit')
      ON CONFLICT (session_id) DO UPDATE SET cooldown_until = EXCLUDED.cooldown_until;
      UPDATE wacrm.disp_message_queue SET status='enviado', sent_at=date_trunc('minute', now()) WHERE id IN ('${id(1)}','${id(2)}','${id(3)}');
    `);
    const cooldowns = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM wacrm.dispatch_channel_cooldowns');
    expect(cooldowns.rows[0].n).toBe(1);
    const rows = await db.query<{ session_id: string; sent: number }>(
      'SELECT session_id, sent FROM wacrm.dispatch_throughput_per_minute'
    );
    expect(rows.rows).toEqual([{ session_id: channel, sent: 3 }]);
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const campaign = '00000000-0000-0000-0000-000000000011';
const otherCampaign = '00000000-0000-0000-0000-000000000012';
const channel = '00000000-0000-0000-0000-000000000021';
const item = '00000000-0000-0000-0000-000000000031';
const otherItem = '00000000-0000-0000-0000-000000000032';
let db: PGlite;

async function callBoolean(fn: string, id: string) {
  const result = await db.query<{ result: boolean }>(
    `SELECT wacrm.${fn}($1::uuid) AS result`,
    [id]
  );
  return result.rows[0].result;
}

describe('dispatch safety migration on embedded PostgreSQL', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA wacrm;
      CREATE TABLE wacrm.whatsapp_config (id uuid PRIMARY KEY);
      CREATE TABLE wacrm.campaigns (id uuid PRIMARY KEY, account_id uuid DEFAULT '00000000-0000-0000-0000-000000000001', status text, limite_por_hora int, batch_pause_seconds int, updated_at timestamptz);
      CREATE TABLE wacrm.disp_message_queue (
        id uuid PRIMARY KEY, campaign_id uuid REFERENCES wacrm.campaigns, session_id uuid, contact_id uuid,
        status text, scheduled_at timestamptz, updated_at timestamptz, sent_at timestamptz,
        waha_message_id text, tentativas int DEFAULT 0, erro_permanente boolean DEFAULT false, erro text
      );
      CREATE TABLE wacrm.message_logs (queue_id uuid, campaign_id uuid, contact_id uuid, session_id uuid, direcao text, mensagem text, status text, waha_message_id text);
      CREATE TABLE wacrm.campaign_metrics (campaign_id uuid PRIMARY KEY, total_enviados int DEFAULT 0, total_entregues int DEFAULT 0, total_lidos int DEFAULT 0, total_erros int DEFAULT 0);
      CREATE FUNCTION wacrm.increment_campaign_metric(p_campaign_id uuid, p_field text) RETURNS void LANGUAGE sql AS $$
        INSERT INTO wacrm.campaign_metrics(campaign_id) VALUES(p_campaign_id) ON CONFLICT DO NOTHING;
        UPDATE wacrm.campaign_metrics SET
          total_enviados=total_enviados+CASE WHEN p_field='total_enviados' THEN 1 ELSE 0 END,
          total_entregues=total_entregues+CASE WHEN p_field='total_entregues' THEN 1 ELSE 0 END,
          total_lidos=total_lidos+CASE WHEN p_field='total_lidos' THEN 1 ELSE 0 END,
          total_erros=total_erros+CASE WHEN p_field='total_erros' THEN 1 ELSE 0 END WHERE campaign_id=p_campaign_id;
      $$;
      INSERT INTO wacrm.whatsapp_config VALUES ('${channel}');
    `);
    await db.exec(
      readFileSync(
        resolve('supabase/migrations/118_dispatch_safety.sql'),
        'utf8'
      )
    );
    await db.exec(
      readFileSync(
        resolve('supabase/migrations/119_dispatch_status_transitions.sql'),
        'utf8'
      )
    );
  }, 30_000);
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await db.exec(`
      TRUNCATE wacrm.disp_message_queue, wacrm.campaign_metrics, wacrm.message_logs, wacrm.dispatch_channel_limits;
      DELETE FROM wacrm.campaigns;
      INSERT INTO wacrm.campaigns(id,status,limite_por_hora,batch_pause_seconds) VALUES ('${campaign}','em_execucao',10,60),('${otherCampaign}','em_execucao',10,60);
      INSERT INTO wacrm.disp_message_queue(id,campaign_id,session_id,status,scheduled_at)
      VALUES('${item}','${campaign}','${channel}','agendado',now()),('${otherItem}','${otherCampaign}','${channel}','agendado',now());
    `);
  });
  it('allows only one claim and prevents premature completion', async () => {
    expect(await callBoolean('claim_dispatch_item', item)).toBe(true);
    expect(await callBoolean('claim_dispatch_item', item)).toBe(false);
    expect(await callBoolean('complete_dispatch_campaign', campaign)).toBe(
      false
    );
  });
  it('does not consume a campaign still being prepared', async () => {
    await db.query('UPDATE wacrm.campaigns SET status=$1 WHERE id=$2', [
      'preparando',
      campaign,
    ]);
    expect(await callBoolean('claim_dispatch_item', item)).toBe(false);
    expect(await callBoolean('complete_dispatch_campaign', campaign)).toBe(
      false
    );
  });
  it('does not send a legacy scheduled item that already carries a provider receipt', async () => {
    await db.query(
      'UPDATE wacrm.disp_message_queue SET waha_message_id=$1 WHERE id=$2',
      ['wamid.already-accepted', item]
    );
    expect(await callBoolean('claim_dispatch_item', item)).toBe(false);
  });
  it('shares in-flight and hourly channel limits between campaigns', async () => {
    await db.query(
      'INSERT INTO wacrm.dispatch_channel_limits VALUES ($1,1,1)',
      [channel]
    );
    expect(await callBoolean('claim_dispatch_item', item)).toBe(true);
    expect(await callBoolean('claim_dispatch_item', otherItem)).toBe(false);
    await db.query(
      "UPDATE wacrm.disp_message_queue SET status='enviado',sent_at=now() WHERE id=$1",
      [item]
    );
    expect(await callBoolean('claim_dispatch_item', otherItem)).toBe(false);
  });
  it('counts existing in-flight work against the campaign hourly budget', async () => {
    await db.query('UPDATE wacrm.campaigns SET limite_por_hora=1 WHERE id=$1', [
      campaign,
    ]);
    await db.query(
      'UPDATE wacrm.disp_message_queue SET campaign_id=$1 WHERE id=$2',
      [campaign, otherItem]
    );
    expect(await callBoolean('claim_dispatch_item', item)).toBe(true);
    expect(await callBoolean('claim_dispatch_item', otherItem)).toBe(false);
  });
  it('reserves cadence once, even if the backlog was scheduled in the past', async () => {
    expect(await callBoolean('reserve_campaign_tick', campaign)).toBe(true);
    expect(await callBoolean('reserve_campaign_tick', campaign)).toBe(false);
  });
  it('confirms locally once and has a single completion winner', async () => {
    expect(await callBoolean('claim_dispatch_item', item)).toBe(true);
    const confirm = () =>
      db.query('SELECT wacrm.mark_queue_item_sent($1,$2,NULL,$3,$4,$5,1)', [
        item,
        campaign,
        channel,
        'hello',
        'wamid.test',
      ]);
    await confirm();
    await confirm();
    expect(
      (
        await db.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM wacrm.message_logs'
        )
      ).rows[0].count
    ).toBe(1);
    expect(
      (
        await db.query<{ total_enviados: number }>(
          'SELECT total_enviados FROM wacrm.campaign_metrics'
        )
      ).rows[0].total_enviados
    ).toBe(1);
    expect(await callBoolean('complete_dispatch_campaign', campaign)).toBe(
      true
    );
    expect(await callBoolean('complete_dispatch_campaign', campaign)).toBe(
      false
    );
  });
  it('does not authorize browser roles to call operational RPCs', async () => {
    const result = await db.query<{ allowed: boolean }>(
      "SELECT has_function_privilege('authenticated','wacrm.claim_dispatch_item(uuid)','execute') AS allowed"
    );
    expect(result.rows[0].allowed).toBe(false);
    const service = await db.query<{ allowed: boolean }>(
      "SELECT has_function_privilege('service_role','wacrm.claim_dispatch_item(uuid)','execute') AS allowed"
    );
    expect(service.rows[0].allowed).toBe(true);
  });
  it('deduplicates receipts, counts a direct read as delivered and never regresses', async () => {
    await callBoolean('claim_dispatch_item', item);
    await db.query('SELECT wacrm.mark_queue_item_sent($1,$2,NULL,$3,$4,$5,1)', [
      item,
      campaign,
      channel,
      'hello',
      'wamid.test',
    ]);
    const status = (value: string) =>
      db.query<{ changed: boolean }>(
        'SELECT wacrm.apply_dispatch_status($1,$2,NULL) AS changed',
        ['wamid.test', value]
      );
    expect((await status('read')).rows[0].changed).toBe(true);
    expect((await status('read')).rows[0].changed).toBe(false);
    expect((await status('delivered')).rows[0].changed).toBe(false);
    expect((await status('failed')).rows[0].changed).toBe(false);
    const metrics = (
      await db.query(
        'SELECT total_entregues,total_lidos,total_erros FROM wacrm.campaign_metrics'
      )
    ).rows[0];
    expect(metrics).toEqual({
      total_entregues: 1,
      total_lidos: 1,
      total_erros: 0,
    });
  });
  it('does not allow an asynchronous failure to trigger an automatic resend', async () => {
    await callBoolean('claim_dispatch_item', item);
    await db.query('SELECT wacrm.mark_queue_item_sent($1,$2,NULL,$3,$4,$5,1)', [
      item,
      campaign,
      channel,
      'hello',
      'wamid.test',
    ]);
    await db.query('SELECT wacrm.apply_dispatch_status($1,$2,$3)', [
      'wamid.test',
      'failed',
      'delivery rejected',
    ]);
    const result = (
      await db.query(
        'SELECT status,erro_permanente FROM wacrm.disp_message_queue WHERE id=$1',
        [item]
      )
    ).rows[0];
    expect(result).toEqual({ status: 'erro', erro_permanente: true });
  });
  it('does not reopen in-flight work when pausing and resuming, or resurrect a stopped campaign', async () => {
    await callBoolean('claim_dispatch_item', item);
    const accountId = '00000000-0000-0000-0000-000000000001';
    await db.query("SELECT wacrm.stop_dispatch_campaign($1,$2,'pause')", [
      campaign,
      accountId,
    ]);
    await db.query('SELECT wacrm.resume_dispatch_campaign($1,$2)', [
      campaign,
      accountId,
    ]);
    expect(
      (
        await db.query<{ status: string }>(
          'SELECT status FROM wacrm.disp_message_queue WHERE id=$1',
          [item]
        )
      ).rows[0].status
    ).toBe('enviando');
    await db.query("SELECT wacrm.stop_dispatch_campaign($1,$2,'stop')", [
      campaign,
      accountId,
    ]);
    expect(
      (
        await db.query<{ count: number | null }>(
          'SELECT wacrm.resume_dispatch_campaign($1,$2) AS count',
          [campaign, accountId]
        )
      ).rows[0].count
    ).toBe(null);
  });
});

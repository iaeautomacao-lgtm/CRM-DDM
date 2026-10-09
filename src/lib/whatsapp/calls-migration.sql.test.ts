// Migrations 250 (CDR + apply_call_event) e 251 (call_permissions) — PGlite com as migrations reais.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let db: PGlite;
const migration = (file: string) => readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '');
const ACC = 'a0000000-0000-0000-0000-000000000001';
const OTHER = 'a0000000-0000-0000-0000-000000000002';
const CONV = 'c0000000-0000-0000-0000-000000000001';
const CONTACT = 'd0000000-0000-0000-0000-000000000001';
const CH = 'b0000000-0000-0000-0000-000000000001';

type R = { result: string; id?: string; status?: string; duration_seconds?: number; became_terminal?: boolean };
const T0 = '2026-10-09T12:00:00Z';
const at = (sec: number) => new Date(Date.parse(T0) + sec * 1000).toISOString();

async function apply(over: Partial<Record<string, unknown>> = {}): Promise<R> {
  const a = {
    account: ACC, channel: CH, conv: CONV, contact: CONTACT, id: 'wacid.1', dir: 'inbound', status: 'ringing',
    event: at(0), start: null, end: null, duration: null, cause: null, ...over,
  };
  return (
    await db.query<{ r: R }>('SELECT wacrm.apply_call_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) AS r', [
      a.account, a.channel, a.conv, a.contact, a.id, a.dir, a.status, a.event, a.start, a.end, a.duration, a.cause,
    ])
  ).rows[0].r;
}
const cdr = async (id: string) =>
  (await db.query<Record<string, unknown>>('SELECT status, direction, answered_at, ended_at, duration_seconds, hangup_cause FROM wacrm.call_detail_records WHERE meta_call_id = $1', [id])).rows[0];

describe('migrations 250/251', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA wacrm;
      CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY);
      CREATE TABLE wacrm.contacts (id uuid PRIMARY KEY);
      CREATE TABLE wacrm.conversations (id uuid PRIMARY KEY);
      CREATE TABLE wacrm.whatsapp_config (id uuid PRIMARY KEY);
      CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
      CREATE FUNCTION wacrm.is_account_member(p uuid) RETURNS boolean LANGUAGE sql AS $f$ SELECT true $f$;
      INSERT INTO wacrm.accounts VALUES ('${ACC}'), ('${OTHER}');
      INSERT INTO wacrm.contacts VALUES ('${CONTACT}');
      INSERT INTO wacrm.conversations VALUES ('${CONV}');
      INSERT INTO wacrm.whatsapp_config VALUES ('${CH}');
    `);
    for (const f of ['250_calling_cdr.sql', '251_call_permissions.sql']) {
      const sql = migration(f);
      await db.exec(sql);
      await db.exec(sql); // idempotente
    }
  });
  afterAll(async () => {
    await db.close();
  });

  it('registram a si mesmas em schema_migrations e criam a coluna de gravação por canal (desligada)', async () => {
    const v = (await db.query<{ version: string }>("SELECT version FROM wacrm.schema_migrations ORDER BY version")).rows.map((r) => r.version);
    expect(v).toEqual(['250_calling_cdr', '251_call_permissions']);
    const col = (await db.query<{ column_default: string }>("SELECT column_default FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='whatsapp_config' AND column_name='calling_recording_enabled'")).rows;
    expect(col[0].column_default).toBe('false');
  });

  describe('apply_call_event', () => {
    it('chamada recebida: ringing → connected → ended; duração calculada pelo banco (answered_at → ended_at)', async () => {
      expect(await apply({ id: 'w-a', status: 'ringing' })).toMatchObject({ result: 'created', status: 'ringing' });
      expect(await apply({ id: 'w-a', status: 'connected', event: at(5) })).toMatchObject({ result: 'updated', status: 'connected' });
      const end = await apply({ id: 'w-a', status: 'ended', event: at(5 + 222) });
      expect(end).toMatchObject({ result: 'updated', status: 'ended', duration_seconds: 222, became_terminal: true });
      expect(await cdr('w-a')).toMatchObject({ status: 'ended', direction: 'inbound', duration_seconds: 222 });
    });

    it('a Meta informa a duração (duration/start_time/end_time): vale a informada', async () => {
      await apply({ id: 'w-b', dir: 'outbound', status: 'ringing' });
      const r = await apply({ id: 'w-b', dir: 'outbound', status: 'ended', start: at(10), end: at(70), duration: 58, event: at(70) });
      expect(r).toMatchObject({ status: 'ended', duration_seconds: 58 });
    });

    it('é monotônico: evento atrasado ou repetido não volta o estado; terminal congela', async () => {
      await apply({ id: 'w-c', status: 'ringing' });
      await apply({ id: 'w-c', status: 'connected', event: at(3) });
      expect((await apply({ id: 'w-c', status: 'ringing', event: at(1) })).result).toBe('unchanged'); // atrasado
      expect((await apply({ id: 'w-c', status: 'connected', event: at(3) })).status).toBe('connected'); // repetido
      await apply({ id: 'w-c', status: 'ended', event: at(63) });
      expect((await apply({ id: 'w-c', status: 'connected', event: at(64) }))).toMatchObject({ result: 'unchanged', status: 'ended', duration_seconds: 60 });
      expect((await apply({ id: 'w-c', status: 'failed', event: at(65) })).result).toBe('unchanged');
    });

    it('recebida que termina sem nunca ser atendida vira missed, duração 0', async () => {
      await apply({ id: 'w-d', status: 'ringing' });
      expect(await apply({ id: 'w-d', status: 'ended', event: at(30) })).toMatchObject({ status: 'missed', duration_seconds: 0, became_terminal: true });
    });

    it('rejeitada/falha: terminal, sem duração, com a causa guardada', async () => {
      await apply({ id: 'w-e', dir: 'outbound', status: 'ringing' });
      expect(await apply({ id: 'w-e', dir: 'outbound', status: 'failed', cause: '131053: call_permission_required', event: at(2) })).toMatchObject({ status: 'failed', duration_seconds: 0 });
      expect((await cdr('w-e')).hangup_cause).toBe('131053: call_permission_required');
    });

    it('status avulso (sem conversa/contato) só atualiza chamada existente; desconhecida não cria', async () => {
      expect(await apply({ id: 'w-nao-existe', conv: null, contact: null, status: 'connected' })).toEqual({ result: 'unknown_call' });
      await apply({ id: 'w-f', status: 'ringing' });
      expect(await apply({ id: 'w-f', conv: null, contact: null, status: 'connected', event: at(4) })).toMatchObject({ result: 'updated', status: 'connected' });
    });

    it('mesmo meta_call_id de OUTRA conta é ignorado; entradas inválidas também', async () => {
      await apply({ id: 'w-g', status: 'ringing' });
      expect(await apply({ id: 'w-g', account: OTHER, status: 'ended' })).toEqual({ result: 'account_mismatch' });
      expect((await cdr('w-g')).status).toBe('ringing');
      expect(await apply({ id: 'w-h', status: 'talvez' })).toEqual({ result: 'invalid' });
      expect(await apply({ id: '', status: 'ringing' })).toEqual({ result: 'invalid' });
      expect(await apply({ id: 'w-i', dir: 'lateral' })).toEqual({ result: 'invalid' });
    });

    it('concorrência: vários eventos do mesmo id em paralelo terminam em UM registro no estado mais avançado', async () => {
      await Promise.all(['ringing', 'connected', 'ended', 'ringing', 'connected'].map((status, i) => apply({ id: 'w-j', status, event: at(i * 10) })));
      expect((await db.query('SELECT 1 FROM wacrm.call_detail_records WHERE meta_call_id = $1', ['w-j'])).rows).toHaveLength(1);
      expect((await cdr('w-j')).status).toBe('ended');
    });
  });

  describe('call_permissions', () => {
    const record = async (phone: string, grantedSec: number, expires: string, source = 'interactive_optin', account = ACC) =>
      (await db.query<{ ok: boolean }>('SELECT wacrm.record_call_permission($1,$2,$3,$4,$5,$6) AS ok', [account, CONTACT, phone, at(grantedSec), expires, source])).rows[0].ok;
    const has = async (phone: string, account = ACC) =>
      (await db.query<{ ok: boolean }>('SELECT wacrm.has_call_permission($1,$2) AS ok', [account, phone])).rows[0].ok;

    it('vigente = true; expirada ou inexistente = false; permanente (infinity) = true', async () => {
      await record('5511999990001', 0, '2999-01-01T00:00:00Z');
      await record('5511999990002', 0, '2000-01-01T00:00:00Z');
      await record('5511999990003', 0, 'infinity');
      expect(await has('5511999990001')).toBe(true);
      expect(await has('5511999990002')).toBe(false);
      expect(await has('5511999990003')).toBe(true);
      expect(await has('5511000000000')).toBe(false);
    });

    it('é por conta: a permissão de uma conta não vale para outra', async () => {
      await record('5511999990010', 0, '2999-01-01T00:00:00Z');
      expect(await has('5511999990010', OTHER)).toBe(false);
    });

    it('recusa (expira no passado) revoga; evento ATRASADO não sobrescreve um mais novo', async () => {
      await record('5511999990020', 100, '2999-01-01T00:00:00Z');
      expect(await record('5511999990020', 50, '2000-01-01T00:00:00Z')).toBe(false); // atrasado: ignorado
      expect(await has('5511999990020')).toBe(true);
      expect(await record('5511999990020', 200, '2000-01-01T00:00:00Z')).toBe(true); // recusa mais nova revoga
      expect(await has('5511999990020')).toBe(false);
      expect(await record('5511999990020', 300, '2999-01-01T00:00:00Z', 'template_button')).toBe(true); // aceita de novo
      expect(await has('5511999990020')).toBe(true);
    });

    it('telefone só com dígitos e origem conhecida', async () => {
      await expect(record('+55 11 99999', 0, 'infinity')).rejects.toThrow();
      await expect(record('5511999990030', 0, 'infinity', 'magica')).rejects.toThrow();
    });
  });

  it('fechadas: anon sem acesso; authenticated só SELECT; só service_role executa as funções', async () => {
    const g = await db.query<{ r: string; sel: boolean; ins: boolean; f: boolean }>(`
      SELECT r,
             has_table_privilege(r, 'wacrm.call_detail_records', 'SELECT') AS sel,
             has_table_privilege(r, 'wacrm.call_detail_records', 'INSERT') AS ins,
             has_function_privilege(r, 'wacrm.apply_call_event(uuid,uuid,uuid,uuid,text,text,text,timestamptz,timestamptz,timestamptz,integer,text)', 'EXECUTE') AS f
        FROM (VALUES ('anon'), ('authenticated'), ('service_role')) v(r)`);
    expect(Object.fromEntries(g.rows.map((x) => [x.r, [x.sel, x.ins, x.f]]))).toEqual({
      anon: [false, false, false], authenticated: [true, false, false], service_role: [true, true, true],
    });
    const p = await db.query<{ r: string; f: boolean; w: boolean }>(`
      SELECT r, has_function_privilege(r, 'wacrm.record_call_permission(uuid,uuid,text,timestamptz,timestamptz,text)', 'EXECUTE') AS f,
             has_table_privilege(r, 'wacrm.call_permissions', 'INSERT') AS w
        FROM (VALUES ('anon'), ('authenticated'), ('service_role')) v(r)`);
    expect(Object.fromEntries(p.rows.map((x) => [x.r, [x.f, x.w]]))).toEqual({ anon: [false, false], authenticated: [false, false], service_role: [true, true] });
  });
});

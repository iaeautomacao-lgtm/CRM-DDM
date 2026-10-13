// Migration 327: _bcast_bump e recompute_broadcast_counts deixam de ser executáveis por PUBLIC/anon/authenticated; o trigger (definer) continua atualizando os contadores.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

import { headerRollback, migration } from "./rls-fixture";

describe("migration 327 — REVOKE nas funções de contador de broadcast", { timeout: 60_000 }, () => {
  let db: PGlite;
  const canExec = async (role: string, fn: string) =>
    (await db.query<{ ok: boolean }>(`SELECT has_function_privilege('${role}', '${fn}'::regprocedure, 'EXECUTE') AS ok`)).rows[0].ok;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA wacrm;
      CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
      CREATE TABLE public.broadcasts (id uuid PRIMARY KEY, sent_count int DEFAULT 0, updated_at timestamptz);
      CREATE TABLE public.broadcast_recipients (id serial PRIMARY KEY, broadcast_id uuid, status text);
      CREATE FUNCTION public._bcast_bump(bid uuid, col text, delta int) RETURNS void AS $$
        BEGIN EXECUTE format('UPDATE broadcasts SET %I = GREATEST(0, %I + $1), updated_at = now() WHERE id = $2', col, col) USING delta, bid; END;
      $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
      CREATE FUNCTION public.recompute_broadcast_counts(bid uuid) RETURNS void AS $$ BEGIN NULL; END; $$ LANGUAGE plpgsql SECURITY DEFINER;
      CREATE FUNCTION wacrm.increment_unread_count(conversation_id uuid) RETURNS void AS $$ BEGIN NULL; END; $$ LANGUAGE plpgsql SECURITY DEFINER;
      GRANT EXECUTE ON FUNCTION wacrm.increment_unread_count(uuid) TO authenticated;
      CREATE FUNCTION public.agg_trigger() RETURNS trigger AS $$ BEGIN PERFORM _bcast_bump(NEW.broadcast_id, 'sent_count', 1); RETURN NEW; END; $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
      CREATE TRIGGER agg AFTER INSERT ON public.broadcast_recipients FOR EACH ROW EXECUTE FUNCTION public.agg_trigger();
      GRANT ALL ON public.broadcasts, public.broadcast_recipients TO authenticated;
      GRANT USAGE ON SEQUENCE public.broadcast_recipients_id_seq TO authenticated;
      INSERT INTO public.broadcasts (id) VALUES ('00000000-0000-0000-0000-000000000001');
    `);
  });
  afterAll(async () => {
    await db.close();
  });

  it("antes: PUBLIC executa (o furo)", async () => {
    expect(await canExec("authenticated", "public._bcast_bump(uuid,text,int)")).toBe(true);
    expect(await canExec("anon", "public.recompute_broadcast_counts(uuid)")).toBe(true);
  });

  it("depois: anon/authenticated não executam; service_role sim; o trigger definer continua somando", async () => {
    await db.exec(migration("327_revoke_broadcast_counters.sql"));
    for (const fn of ["public._bcast_bump(uuid,text,int)", "public.recompute_broadcast_counts(uuid)"]) {
      expect(await canExec("authenticated", fn), fn).toBe(false);
      expect(await canExec("anon", fn), fn).toBe(false);
      expect(await canExec("service_role", fn), fn).toBe(true);
    }
    expect(await canExec("authenticated", "wacrm.increment_unread_count(uuid)")).toBe(false);
    expect(await canExec("service_role", "wacrm.increment_unread_count(uuid)")).toBe(true);
    await db.exec(`SET ROLE authenticated`);
    await expect(db.query(`SELECT public._bcast_bump('00000000-0000-0000-0000-000000000001', 'sent_count', 5)`)).rejects.toThrow(/permission denied/i);
    await db.exec(`INSERT INTO public.broadcast_recipients (broadcast_id, status) VALUES ('00000000-0000-0000-0000-000000000001', 'sent')`);
    await db.exec(`RESET ROLE`);
    expect((await db.query<{ sent_count: number }>(`SELECT sent_count FROM public.broadcasts`)).rows[0].sent_count).toBe(1);
  });

  it("ROLLBACK do cabeçalho é executável e devolve o EXECUTE a PUBLIC; reaplicar funciona", async () => {
    await db.exec(headerRollback("327_revoke_broadcast_counters.sql"));
    expect(await canExec("authenticated", "public._bcast_bump(uuid,text,int)")).toBe(true);
    await db.exec(migration("327_revoke_broadcast_counters.sql"));
    expect(await canExec("authenticated", "public._bcast_bump(uuid,text,int)")).toBe(false);
  });
});

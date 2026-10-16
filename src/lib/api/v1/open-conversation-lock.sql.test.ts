// Migration 383 (M4 da revisão de segurança 16/10): wacrm.api_open_conversation abre o atendimento serializando por conta+contato+canal e
// devolve a conversa aberta que já existir (created=false). PGlite é uma conexão só: a corrida real não dá para disparar aqui, então o teste prova
// o contrato (achar × criar, canal, status, conta), a trava no código, os privilégios, a idempotência, o pré-check e o rollback.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

import { ACC, ACC_B, createRolesDb, headerRollback, id, migration } from "@/lib/security/rls-fixture";

const CONTACT = id(501);
const CONTACT_2 = id(502);
const META = id(601);
const META_2 = id(602);
const OWNER = id(701);
const AGENT = id(702);
const SIG = "wacrm.api_open_conversation(uuid,uuid,uuid,text,uuid,uuid,text,uuid)";

type Opened = { id: string; created: boolean };

describe("migration 383 — abertura de conversa pela API sem duplicar", { timeout: 180_000 }, () => {
  let db: PGlite;
  const open = async (over: Partial<{ account: string; contact: string; status: string; assignee: string | null; team: string | null; waha: string | null; config: string | null }> = {}) => {
    const a = { account: ACC, contact: CONTACT, status: "pending", assignee: null, team: null, waha: null, config: META, ...over };
    return (await db.query<{ r: Opened }>(`SELECT wacrm.api_open_conversation($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6::uuid,$7,$8::uuid) AS r`, [a.account, OWNER, a.contact, a.status, a.assignee, a.team, a.waha, a.config])).rows[0].r;
  };
  const count = async () => (await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM wacrm.conversations`)).rows[0].c;

  beforeAll(async () => {
    db = await createRolesDb();
  }, 120_000);
  afterAll(async () => {
    await db.close();
  });

  it("pré-check: faltando colunas de wacrm.conversations aborta sem criar a função", async () => {
    await expect(db.exec(migration("383_api_open_conversation_lock.sql"))).rejects.toThrow(/faltam colunas em wacrm\.conversations/);
    await db.exec("ROLLBACK"); // o script abortou dentro do BEGIN: encerra a transação aberta, como o SQL Editor faria
    expect((await db.query(`SELECT to_regprocedure('${SIG}') AS f`)).rows[0]).toEqual({ f: null });
    await db.exec(`
      ALTER TABLE wacrm.conversations ALTER COLUMN id SET DEFAULT gen_random_uuid();
      ALTER TABLE wacrm.conversations ADD COLUMN user_id uuid, ADD COLUMN contact_id uuid, ADD COLUMN waha_session text, ADD COLUMN config_id uuid, ADD COLUMN channel_type text DEFAULT 'whatsapp';
    `);
    await db.exec(migration("383_api_open_conversation_lock.sql"));
  });

  it("a primeira chamada cria; a seguinte para o mesmo contato e canal devolve a MESMA conversa (created=false), sem duplicar", async () => {
    const first = await open({ assignee: AGENT, status: "open" });
    expect(first.created).toBe(true);
    const second = await open({ status: "pending" });
    expect(second).toEqual({ id: first.id, created: false });
    expect(await count()).toBe(1);
    expect((await db.query(`SELECT status, assigned_agent_id, user_id, channel_type FROM wacrm.conversations WHERE id = $1`, [first.id])).rows[0]).toEqual({ status: "open", assigned_agent_id: AGENT, user_id: OWNER, channel_type: "whatsapp" });
  });

  it("outro contato, outro canal Meta, WAHA, outra conta e conversa encerrada: cada um tem o seu atendimento", async () => {
    const a = await open({ contact: CONTACT_2 });
    const b = await open({ config: META_2 });
    const waha = await open({ config: null, waha: "sess1" });
    const waha2 = await open({ config: null, waha: "sess1" });
    const other = await open({ account: ACC_B });
    expect([a.created, b.created, waha.created, other.created]).toEqual([true, true, true, true]);
    expect(waha2).toEqual({ id: waha.id, created: false });
    expect(new Set([a.id, b.id, waha.id, other.id]).size).toBe(4);
    await db.query(`UPDATE wacrm.conversations SET status = 'closed' WHERE id = $1`, [a.id]);
    const reopened = await open({ contact: CONTACT_2 });
    expect(reopened.created).toBe(true);
    expect(reopened.id).not.toBe(a.id);
  });

  it("recusa status e canal inválidos (nada é criado)", async () => {
    const before = await count();
    await expect(open({ status: "closed" })).rejects.toThrow(/status inválido/);
    await expect(open({ config: null, waha: null })).rejects.toThrow(/sessão WAHA OU o canal Meta/);
    await expect(open({ config: META, waha: "s" })).rejects.toThrow(/sessão WAHA OU o canal Meta/);
    expect(await count()).toBe(before);
  });

  it("usa trava de transação por conta+contato+canal e não mexe em dado existente nem cria índice", () => {
    const sql = migration("383_api_open_conversation_lock.sql");
    expect(sql).toMatch(/pg_advisory_xact_lock/);
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/CREATE\s+(UNIQUE\s+)?INDEX|UPDATE\s+wacrm\.conversations|DELETE\s+FROM\s+wacrm\.conversations/i);
  });

  it("o navegador (anon/authenticated) não chama a função; service_role chama", async () => {
    for (const role of ["anon", "authenticated"]) {
      expect((await db.query<{ ok: boolean }>(`SELECT has_function_privilege('${role}', '${SIG}', 'EXECUTE') AS ok`)).rows[0].ok).toBe(false);
    }
    expect((await db.query<{ ok: boolean }>(`SELECT has_function_privilege('service_role', '${SIG}', 'EXECUTE') AS ok`)).rows[0].ok).toBe(true);
  });

  it("idempotente, registra a versão e o rollback do cabeçalho remove a função sem tocar nas conversas", async () => {
    const before = await count();
    await db.exec(migration("383_api_open_conversation_lock.sql"));
    expect((await db.query(`SELECT 1 FROM wacrm.schema_migrations WHERE version = '383_api_open_conversation_lock'`)).rows).toHaveLength(1);
    await db.exec(headerRollback("383_api_open_conversation_lock.sql"));
    expect((await db.query(`SELECT to_regprocedure('${SIG}') AS f`)).rows[0]).toEqual({ f: null });
    expect((await db.query(`SELECT 1 FROM wacrm.schema_migrations WHERE version = '383_api_open_conversation_lock'`)).rows).toHaveLength(0);
    expect(await count()).toBe(before);
  });
});

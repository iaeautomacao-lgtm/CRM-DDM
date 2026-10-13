// Migration 347 (RLS fase 3, escrita): conversas por permissão do atendimento; messages só leitura para o navegador.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

import { ACC, ACC_B, SYSTEM, T1, U, asUser, createRolesDb, headerRollback, id, migration } from "./rls-fixture";
import { writeSnapshot, type WriteProbe, type WriteSnap } from "./rls-write-fixture";

const CV = id(601);
const M1 = id(611);

const CONV: WriteProbe[] = [
  { table: "conversations", insert: `INSERT INTO wacrm.conversations (id, account_id, status) VALUES (gen_random_uuid(), '${ACC}', 'open')`, update: `UPDATE wacrm.conversations SET status = 'pending' WHERE id = '${CV}' RETURNING 1`, delete: `DELETE FROM wacrm.conversations WHERE id = '${CV}' RETURNING 1` },
];
const MSG: WriteProbe[] = [
  { table: "messages", insert: `INSERT INTO wacrm.messages (conversation_id, body) VALUES ('${CV}', 'oi')`, update: `UPDATE wacrm.messages SET body = 'x' WHERE id = '${M1}' RETURNING 1`, delete: `DELETE FROM wacrm.messages WHERE id = '${M1}' RETURNING 1` },
];
const ALL = [...CONV, ...MSG];

describe("migration 347 — escrita de conversas por permissão e messages só leitura", { timeout: 240_000 }, () => {
  let db: PGlite;
  const before: Record<string, WriteSnap> = {};
  const after: Record<string, WriteSnap> = {};
  const readMsgs: Record<string, string[]> = {};
  const everyone = () => [...SYSTEM, "other", "soReply", "soClose", "soView", "soDelAdmin", "soDelSup"];
  const msgs = async (who: string) => (await asUser<{ id: string }>(db, who, `SELECT id::text FROM wacrm.messages`)).map((r) => r.id);

  beforeAll(async () => {
    db = await createRolesDb([
      { who: "soReply", compat: "viewer", permissions: ["inbox.view", "inbox.reply"] },
      { who: "soClose", compat: "viewer", permissions: ["inbox.view", "inbox.close"] },
      { who: "soView", compat: "admin", permissions: ["inbox.view"] },
      { who: "soDelAdmin", compat: "admin", permissions: ["inbox.view", "inbox.delete_conversation"] },
      { who: "soDelSup", compat: "supervisor", permissions: ["inbox.view", "inbox.delete_conversation"] },
    ]);
    await db.exec(`
      CREATE TABLE wacrm.messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid, body text);
      GRANT SELECT, INSERT, UPDATE, DELETE ON wacrm.messages, wacrm.conversations TO authenticated;
      ALTER TABLE wacrm.conversations ENABLE ROW LEVEL SECURITY;
      ALTER TABLE wacrm.messages ENABLE ROW LEVEL SECURITY;
      -- ANTES (017, 108): leitura por membro; escrita por papel; messages_modify FOR ALL
      DROP POLICY IF EXISTS conversations_insert ON wacrm.conversations; DROP POLICY IF EXISTS conversations_update ON wacrm.conversations; DROP POLICY IF EXISTS conversations_delete ON wacrm.conversations;
      CREATE POLICY conversations_insert ON wacrm.conversations FOR INSERT WITH CHECK (wacrm.is_account_member(account_id, 'agent'));
      CREATE POLICY conversations_update ON wacrm.conversations FOR UPDATE USING (wacrm.is_account_member(account_id, 'agent'));
      CREATE POLICY conversations_delete ON wacrm.conversations FOR DELETE USING (wacrm.is_account_member(account_id, 'admin'));
      CREATE POLICY messages_select ON wacrm.messages FOR SELECT USING (EXISTS (SELECT 1 FROM wacrm.conversations c WHERE c.id = messages.conversation_id AND wacrm.is_account_member(c.account_id)));
      CREATE POLICY messages_modify ON wacrm.messages FOR ALL USING (EXISTS (SELECT 1 FROM wacrm.conversations c WHERE c.id = messages.conversation_id AND wacrm.is_account_member(c.account_id, 'agent'))) WITH CHECK (EXISTS (SELECT 1 FROM wacrm.conversations c WHERE c.id = messages.conversation_id AND wacrm.is_account_member(c.account_id, 'agent')));
      INSERT INTO wacrm.conversations (id, account_id, team_id, status) VALUES ('${CV}', '${ACC}', '${T1}', 'open'), ('${id(602)}', '${ACC_B}', NULL, 'open');
      INSERT INTO wacrm.messages (id, conversation_id, body) VALUES ('${M1}', '${CV}', 'm1');
    `);
    for (const who of everyone()) {
      before[who] = await writeSnapshot(db, who, ALL);
      readMsgs[who] = await msgs(who);
    }

    await db.exec(`SET session_replication_role = replica; UPDATE wacrm.profiles SET role_id = NULL WHERE user_id = '${U.viewer}'; SET session_replication_role = DEFAULT;`);
    await expect(db.exec(migration("347_conversations_messages_write_rls.sql"))).rejects.toThrow(/sem role_id/);
    await db.exec("ROLLBACK");
    await db.exec(`SET session_replication_role = replica; UPDATE wacrm.profiles SET role_id = (SELECT id FROM wacrm.account_roles WHERE key = 'viewer' AND account_id IS NULL) WHERE user_id = '${U.viewer}'; SET session_replication_role = DEFAULT;`);

    await db.exec(migration("347_conversations_messages_write_rls.sql"));
    for (const who of everyone()) after[who] = await writeSnapshot(db, who, ALL);
  }, 200_000);
  afterAll(async () => {
    await db.close();
  }, 60_000);

  it("cenário de hoje: agent+ escreve conversas E messages direto; só admin+ apaga conversa; visualizador e outra conta não escrevem", () => {
    expect(before.agent["conversations.update"]).toBe("ok");
    expect(before.agent["messages.insert"]).toBe("ok");
    expect(before.supervisor["conversations.delete"]).toBe("negado");
    expect(before.admin["conversations.delete"]).toBe("ok");
    expect(before.viewer["conversations.update"]).toBe("negado");
    expect(before.other["conversations.update"]).toBe("negado");
  });

  it("EQUIVALÊNCIA nas conversas: papéis de sistema e outra conta escrevem IGUAL antes e depois (as telas continuam)", () => {
    for (const who of [...SYSTEM, "other"]) {
      for (const k of ["conversations.insert", "conversations.update", "conversations.delete"]) expect(after[who][k], `${who} ${k}`).toBe(before[who][k]);
    }
  });

  it("messages: ninguém escreve pelo navegador (era o furo); a LEITURA de cada usuário não muda", async () => {
    for (const who of everyone()) {
      for (const k of ["messages.insert", "messages.update", "messages.delete"]) expect(after[who][k], `${who} ${k}`).toBe("negado");
      expect(await msgs(who), `${who} leitura`).toEqual(readMsgs[who]);
    }
  });

  it("papel personalizado: inbox.reply ou inbox.close escreve conversas; só inbox.view não; apagar exige a chave E nível admin", () => {
    expect(after.soReply["conversations.update"]).toBe("ok");
    expect(after.soClose["conversations.insert"]).toBe("ok");
    expect(after.soView["conversations.update"]).toBe("negado");
    expect(after.soView["conversations.insert"]).toBe("negado");
    expect(after.soDelAdmin["conversations.delete"]).toBe("ok");
    expect(after.soDelSup["conversations.delete"]).toBe("negado");
    expect(after.soReply["conversations.delete"]).toBe("negado");
  });

  it("ROLLBACK do cabeçalho é SQL executável: devolve EXATAMENTE a escrita de antes (todos os usuários); reaplicar funciona", async () => {
    await db.exec(headerRollback("347_conversations_messages_write_rls.sql"));
    for (const who of everyone()) expect(await writeSnapshot(db, who, ALL), `${who} depois do rollback`).toEqual(before[who]);
    expect((await db.query(`SELECT version FROM wacrm.schema_migrations WHERE version LIKE '347%'`)).rows).toEqual([]);
    await db.exec(migration("347_conversations_messages_write_rls.sql"));
    for (const who of everyone()) expect(await writeSnapshot(db, who, ALL), `${who} reaplicada`).toEqual(after[who]);
  });
});

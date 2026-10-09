// Migration 324 (RLS fase 2, lote L2): conversas e linhas (whatsapp_config) por permissão, não pelo nome do papel.
// O "antes" é a policy REAL da migration 140 (já aplicada pela fixture); o "depois" é a 324. Nos 6 papéis de sistema o conjunto de linhas
// visíveis é IDÊNTICO; só o papel PERSONALIZADO passa a ser decidido pelas permissões dele (e não pelo compat_role).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

import { ACC, ACC_B, SYSTEM, T1, T2, U, asUser, createRolesDb, headerRollback, id, migration } from "./rls-fixture";

const C = { c1: id(301), c2: id(302), c3: id(303), c4: id(304), c5: id(305), c6: id(306), c7: id(307), c8: id(308), c9: id(309), c10: id(310), c11: id(311), cb: id(312) };
const W = { w1: id(401), w2: id(402), w3: id(403), wb: id(404) };
const name = (map: Record<string, string>, v: string) => Object.entries(map).find(([, x]) => x === v)![0];

describe("migration 324 — conversas e whatsapp_config por permissão", { timeout: 180_000 }, () => {
  let db: PGlite;
  const before: Record<string, { conv: string[]; cfg: string[] }> = {};
  const after: Record<string, { conv: string[]; cfg: string[] }> = {};

  const read = async (who: string) => ({
    conv: (await asUser<{ id: string }>(db, who, `SELECT id FROM wacrm.conversations`)).map((r) => name(C, r.id)).sort(),
    cfg: (await asUser<{ id: string }>(db, who, `SELECT id FROM wacrm.whatsapp_config`)).map((r) => name(W, r.id)).sort(),
  });
  const everyone = () => [...SYSTEM, "other", "supEquipe", "soInbox", "todas", "nada"];

  beforeAll(async () => {
    db = await createRolesDb([
      { who: "supEquipe", compat: "supervisor", permissions: ["conversations.scope_team", "inbox.view", "channels.view"] },
      { who: "soInbox", compat: "agent", permissions: ["inbox.view", "channels.view"] },
      { who: "todas", compat: "viewer", permissions: ["conversations.scope_all", "channels.view"] },
      { who: "nada", compat: "agent", permissions: ["contacts.view"] },
    ]);
    // os personalizados também são da equipe T1 (para a regra de equipe valer para eles)
    await db.exec(`INSERT INTO wacrm.team_members VALUES ('${T1}', '${U.supEquipe}'), ('${T1}', '${U.soInbox}'), ('${T1}', '${U.todas}'), ('${T1}', '${U.nada}')`);
    await db.exec(`
      GRANT SELECT ON wacrm.conversations, wacrm.whatsapp_config TO authenticated;
      ALTER TABLE wacrm.conversations ENABLE ROW LEVEL SECURITY; ALTER TABLE wacrm.whatsapp_config ENABLE ROW LEVEL SECURITY;
      INSERT INTO wacrm.conversations (id, account_id, team_id, assigned_agent_id, status) VALUES
        ('${C.c1}', '${ACC}', '${T1}', '${U.agent}', 'open'),          -- equipe T1, do operador
        ('${C.c2}', '${ACC}', '${T1}', NULL, 'open'),                  -- fila T1
        ('${C.c3}', '${ACC}', '${T2}', NULL, 'open'),                  -- fila T2
        ('${C.c4}', '${ACC}', '${T2}', '${U.agent2}', 'open'),         -- do operador 2
        ('${C.c5}', '${ACC}', NULL, '${U.agent2}', 'open'),            -- sem equipe, do operador 2
        ('${C.c6}', '${ACC}', '${T1}', NULL, 'closed'),                -- T1, sem atendente, ENCERRADA (operador não vê)
        ('${C.c7}', '${ACC}', NULL, '${U.supervisor}', 'open'),        -- sem equipe, do supervisor
        ('${C.c8}', '${ACC}', NULL, '${U.agent}', 'open'),             -- sem equipe, do operador da T1 (supervisor vê pela equipe do atendente)
        ('${C.c9}', '${ACC}', '${T2}', NULL, 'pending'),               -- fila T2 pendente
        ('${C.c10}', '${ACC}', '${T1}', '${U.agent2}', 'open'),        -- T1 atribuída ao operador 2 (supervisor vê; operador 1 não)
        ('${C.c11}', '${ACC}', '${T2}', '${U.supervisor}', 'open'),    -- T2 atribuída ao supervisor
        ('${C.cb}', '${ACC_B}', NULL, NULL, 'open');
      INSERT INTO wacrm.whatsapp_config (id, account_id, team_id) VALUES ('${W.w1}', '${ACC}', NULL), ('${W.w2}', '${ACC}', '${T1}'), ('${W.w3}', '${ACC}', '${T2}'), ('${W.wb}', '${ACC_B}', NULL);
    `);
    for (const who of everyone()) before[who] = await read(who);

    // a policy antiga aprovada: ABORTA se faltar role_id (e nada muda)
    await db.exec(`SET session_replication_role = replica; UPDATE wacrm.profiles SET role_id = NULL WHERE user_id = '${U.viewer}'; SET session_replication_role = DEFAULT;`);
    await expect(db.exec(migration("324_conversations_rls_has_perm.sql"))).rejects.toThrow(/sem role_id/);
    await db.exec("ROLLBACK");
    expect(await read("admin")).toEqual(before.admin); // nada mudou
    await db.exec(`SET session_replication_role = replica; UPDATE wacrm.profiles SET role_id = (SELECT id FROM wacrm.account_roles WHERE key = 'viewer' AND account_id IS NULL) WHERE user_id = '${U.viewer}'; SET session_replication_role = DEFAULT;`);

    await db.exec(migration("324_conversations_rls_has_perm.sql"));
    for (const who of everyone()) after[who] = await read(who);
  }, 120_000);
  afterAll(async () => {
    await db.close();
  }, 60_000);

  it("a regra de hoje (140), para conferir o cenário: owner/admin/viewer = conta toda; operador = dele + fila T1; supervisor = equipe T1 + dele + sem equipe de membros da T1", () => {
    for (const w of ["owner", "admin", "viewer"]) expect(before[w].conv).toEqual(["c1", "c10", "c11", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9"].sort());
    expect(before.agent.conv).toEqual(["c1", "c2", "c8"]);
    expect(before.agent2.conv).toEqual(["c10", "c3", "c4", "c5", "c9"].sort()); // c10 está atribuída a ele
    expect(before.supervisor.conv).toEqual(["c1", "c10", "c11", "c2", "c6", "c7", "c8"].sort());
    expect(before.other.conv).toEqual(["cb"]);
  });

  it("EQUIVALÊNCIA: nos 6 papéis de sistema e na outra conta, conversas e linhas visíveis são IDÊNTICAS antes e depois", () => {
    for (const who of [...SYSTEM, "other"]) {
      expect(after[who].conv, `${who} conversas`).toEqual(before[who].conv);
      expect(after[who].cfg, `${who} linhas`).toEqual(before[who].cfg);
    }
  });

  it("supervisor: a cláusula do operador (que ele também tem via inbox.view) não amplia nada — o conjunto é exatamente o de antes", () => {
    expect(after.supervisor.conv).toEqual(["c1", "c10", "c11", "c2", "c6", "c7", "c8"].sort());
  });

  it("whatsapp_config: owner/admin/viewer veem as 3 linhas da conta; operador/supervisor só as da equipe + sem equipe", () => {
    expect(after.owner.cfg).toEqual(["w1", "w2", "w3"]);
    expect(after.viewer.cfg).toEqual(["w1", "w2", "w3"]);
    expect(after.agent.cfg).toEqual(["w1", "w2"]);
    expect(after.supervisor.cfg).toEqual(["w1", "w2"]);
    expect(after.agent2.cfg).toEqual(["w1", "w3"]);
  });

  it("papel PERSONALIZADO decidido pelas permissões, não pelo compat_role", () => {
    // scope_team + inbox.view ⇒ como o supervisor (a regra de 'eu' usa o id dele: c7/c8 entram pela equipe do atendente; c11 e c7-do-supervisor não são dele)
    expect(after.supEquipe.conv).toEqual(["c1", "c10", "c2", "c6", "c7", "c8"].sort());
    // só inbox.view ⇒ como operador: fila T1 aberta (c2); nada atribuído a ele
    expect(after.soInbox.conv).toEqual(["c2"]);
    // scope_all ⇒ conta toda, mesmo com compat viewer
    expect(after.todas.conv).toHaveLength(11);
    expect(after.todas.cfg).toEqual(["w1", "w2", "w3"]);
    // sem nenhuma chave de conversa ⇒ ANTES (compat agent) via a fila; DEPOIS: nada, nem linhas (sem channels.view)
    expect(before.nada.conv).toEqual(["c2"]);
    expect(after.nada.conv).toEqual([]);
    expect(after.nada.cfg).toEqual([]);
  });

  it("ROLLBACK do cabeçalho é SQL executável: devolve EXATAMENTE a regra da 140 (papéis de sistema iguais; o personalizado volta a valer pelo compat_role) e remove o registro", async () => {
    await db.exec(headerRollback("324_conversations_rls_has_perm.sql"));
    for (const who of everyone()) expect(await read(who), `${who} depois do rollback`).toEqual(before[who]);
    expect((await db.query(`SELECT version FROM wacrm.schema_migrations WHERE version LIKE '324%'`)).rows).toEqual([]);
    await db.exec(migration("324_conversations_rls_has_perm.sql")); // reaplica sem erro
    expect(await read("nada")).toEqual(after.nada);
  });

  it("idempotente (uma policy por tabela) e registra a versão", async () => {
    await db.exec(migration("324_conversations_rls_has_perm.sql"));
    const n = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'wacrm' AND tablename IN ('conversations', 'whatsapp_config')`)).rows[0].n;
    expect(n).toBe(2);
    expect((await db.query(`SELECT version FROM wacrm.schema_migrations WHERE version LIKE '324%'`)).rows).toEqual([{ version: "324_conversations_rls_has_perm" }]);
  });
});

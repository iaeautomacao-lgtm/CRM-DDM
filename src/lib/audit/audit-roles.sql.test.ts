// Migration 248 (PRD 20, 20.8): auditoria de papéis, vínculo, convites, propriedade e papéis personalizados.
// PGlite com as migrations REAIS 240 (papéis/sincronia) e 248 sobre a auditoria da 131 reduzida a stand-ins com a MESMA
// assinatura (audit_logs, audit_actor, audit_write, audit_agent_name, audit_generic_changes) — a 131 inteira depende de
// extensões/tabelas que não importam aqui.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const migration = (file: string) =>
  readFileSync(resolve(process.cwd(), "supabase/migrations", file), "utf8").replace(/NOTIFY pgrst[^;]*;/g, "");

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const ACTOR = "00000000-0000-0000-0000-0000000000f1";
const uid = (n: number) => `00000000-0000-0000-0000-0000000001${String(n).padStart(2, "0")}`;

const BOOTSTRAP = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA wacrm; CREATE SCHEMA auth;
  GRANT USAGE ON SCHEMA wacrm, auth TO anon, authenticated, service_role;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
  CREATE TYPE wacrm.account_role_enum AS ENUM ('owner','admin','supervisor','agent','viewer');
  CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL DEFAULT 'conta', owner_user_id uuid);
  CREATE TABLE wacrm.profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL UNIQUE,
    account_id uuid REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
    account_role wacrm.account_role_enum NOT NULL,
    full_name text, avatar_url text, max_simultaneous_chats integer,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE FUNCTION wacrm.current_account_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public
    AS $$ SELECT p.account_id FROM wacrm.profiles p WHERE p.user_id = auth.uid() LIMIT 1 $$;
  CREATE TABLE wacrm.account_invitations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    role wacrm.account_role_enum NOT NULL CHECK (role <> 'owner'),
    created_by_user_id uuid, label text,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    accepted_at timestamptz, accepted_by_user_id uuid
  );
  -- Auditoria da 131 (stand-ins, mesmas assinaturas)
  CREATE TABLE wacrm.audit_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seq bigserial, -- ordem de inserção estável (clock_timestamp pode repetir sob carga)
    account_id uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
    event_type text NOT NULL CHECK (event_type IN ('created','updated','deleted','action')),
    resource_type text NOT NULL, resource_id uuid NOT NULL, resource_label text,
    user_id uuid, user_name text, ip_address text, user_agent text, actor_type text, source text,
    action text, summary text, changes jsonb, metadata jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
  );
  CREATE FUNCTION wacrm.audit_actor() RETURNS jsonb LANGUAGE sql STABLE AS
    $$ SELECT jsonb_build_object('user_id', nullif(current_setting('test.actor', true), ''), 'user_name', 'Ator', 'ip', '203.0.113.1', 'user_agent', 'ua', 'actor_type', 'user', 'source', 'web') $$;
  CREATE FUNCTION wacrm.audit_write(p_account uuid, p_event text, p_resource_type text, p_resource_id uuid, p_label text, p_action text,
      p_summary text, p_changes jsonb DEFAULT NULL, p_metadata jsonb DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
    DECLARE v_actor jsonb := wacrm.audit_actor();
    BEGIN
      IF p_account IS NULL OR p_resource_id IS NULL THEN RETURN; END IF;
      INSERT INTO wacrm.audit_logs (account_id, event_type, resource_type, resource_id, resource_label, user_id, user_name, ip_address, user_agent,
          actor_type, source, action, summary, changes, metadata)
        VALUES (p_account, p_event, p_resource_type, p_resource_id, left(p_label, 200), (v_actor ->> 'user_id')::uuid, v_actor ->> 'user_name',
          v_actor ->> 'ip', v_actor ->> 'user_agent', v_actor ->> 'actor_type', v_actor ->> 'source', p_action, left(p_summary, 500),
          CASE WHEN p_changes = '{}'::jsonb THEN NULL ELSE p_changes END, p_metadata);
    END $$;
  CREATE FUNCTION wacrm.audit_agent_name(p_user uuid) RETURNS text LANGUAGE sql STABLE AS
    $$ SELECT CASE WHEN p_user IS NULL THEN 'Sistema' ELSE coalesce((SELECT nullif(full_name, '') FROM wacrm.profiles WHERE user_id = p_user LIMIT 1), 'Atendente removido') END $$;
  CREATE FUNCTION wacrm.audit_generic_changes() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN coalesce(NEW, OLD); END $$;
  -- trigger genérico de profiles COMO ESTAVA na 131 (inclui account_role)
  CREATE TRIGGER trg_audit_profiles AFTER INSERT OR UPDATE OR DELETE ON wacrm.profiles FOR EACH ROW
    EXECUTE FUNCTION wacrm.audit_generic_changes('member', 'Membro', 'full_name', 'full_name,account_role,max_simultaneous_chats');
  INSERT INTO wacrm.accounts (id, name, owner_user_id) VALUES ('${A}', 'Conta A', '${uid(1)}'), ('${B}', 'Conta B', '${uid(9)}');
`;

type Log = {
  action: string;
  event_type: string;
  resource_type: string;
  account_id: string;
  summary: string;
  changes: Record<string, { before: unknown; after: unknown }> | null;
  metadata: Record<string, unknown> | null;
  user_id: string | null;
  ip_address: string | null;
};

describe("migration 248 — auditoria de papéis", { timeout: 60_000 }, () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(BOOTSTRAP);
    await db.exec(migration("240_roles_foundation.sql"));
    await db.exec(migration("248_audit_roles.sql"));
  }, 60_000);
  afterAll(async () => {
    await db.close();
  }, 60_000);
  beforeEach(async () => {
    await db.exec(`
      SELECT set_config('test.actor', '${ACTOR}', false);
      ALTER TABLE wacrm.audit_logs DROP CONSTRAINT IF EXISTS boom;
      DELETE FROM wacrm.account_invitations; DELETE FROM wacrm.profiles; DELETE FROM wacrm.account_roles WHERE account_id IS NOT NULL;
      DELETE FROM wacrm.audit_logs;
      UPDATE wacrm.accounts SET name = CASE id WHEN '${A}' THEN 'Conta A' ELSE 'Conta B' END, owner_user_id = CASE id WHEN '${A}' THEN '${uid(1)}'::uuid ELSE '${uid(9)}'::uuid END;
      DELETE FROM wacrm.audit_logs;
    `);
  });

  const logs = async (where = "true") =>
    (await db.query<Log>(`SELECT action, event_type, resource_type, account_id, summary, changes, metadata, user_id, ip_address FROM wacrm.audit_logs WHERE ${where} ORDER BY seq`)).rows;
  const addProfile = (n: number, role: string, account = A, name = `Pessoa ${n}`) =>
    db.query(`INSERT INTO wacrm.profiles (user_id, account_id, account_role, full_name) VALUES ($1, $2, $3::wacrm.account_role_enum, $4)`, [uid(n), account, role, name]);
  const roleId = async (key: string) => (await db.query<{ id: string }>(`SELECT id FROM wacrm.account_roles WHERE key = $1 AND account_id IS NULL`, [key])).rows[0].id;

  describe("papel e vínculo do membro", () => {
    it("mudar o papel (RPC legada, account_role) grava member.role_changed com antes → depois e o ator", async () => {
      await addProfile(2, "agent");
      await db.exec(`DELETE FROM wacrm.audit_logs`);
      await db.query(`UPDATE wacrm.profiles SET account_role = 'supervisor' WHERE user_id = $1`, [uid(2)]);
      const rows = await logs();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: "member.role_changed", event_type: "updated", resource_type: "member", account_id: A, user_id: ACTOR, ip_address: "203.0.113.1" });
      expect(rows[0].changes?.account_role).toEqual({ before: "agent", after: "supervisor" });
      expect(rows[0].summary).toBe("Papel de Pessoa 2 alterado: agent → supervisor");
    });

    it("mudar role_id (caminho novo) também grava, com role_id no diff; a sincronia leva o account_role junto", async () => {
      await addProfile(2, "agent");
      await db.exec(`DELETE FROM wacrm.audit_logs`);
      await db.query(`UPDATE wacrm.profiles SET role_id = $2 WHERE user_id = $1`, [uid(2), await roleId("admin")]);
      const rows = await logs();
      expect(rows.map((r) => r.action)).toEqual(["member.role_changed"]);
      expect(rows[0].changes?.account_role).toEqual({ before: "agent", after: "admin" });
      expect(rows[0].changes?.role_id?.after).toBe(await roleId("admin"));
    });

    it("alterar só o nome não gera evento de papel (o genérico cuida do resto)", async () => {
      await addProfile(2, "agent");
      await db.exec(`DELETE FROM wacrm.audit_logs`);
      await db.query(`UPDATE wacrm.profiles SET full_name = 'Outro Nome' WHERE user_id = $1`, [uid(2)]);
      expect(await logs()).toEqual([]);
    });

    it("o trigger genérico de profiles deixou de registrar account_role (sem evento duplicado)", async () => {
      const { rows } = await db.query<{ args: string }>(
        `SELECT pg_get_triggerdef(oid) AS args FROM pg_trigger WHERE tgname = 'trg_audit_profiles' AND tgrelid = 'wacrm.profiles'::regclass`,
      );
      expect(rows[0].args).toContain("full_name,max_simultaneous_chats");
      expect(rows[0].args).not.toContain("account_role");
    });

    it("P-09: mudança de vínculo grava 'saiu' na conta ANTIGA e 'entrou' na NOVA (nunca um member.updated na nova)", async () => {
      await addProfile(3, "agent", A);
      await db.exec(`DELETE FROM wacrm.audit_logs`);
      await db.query(`UPDATE wacrm.profiles SET account_id = $2, account_role = 'owner' WHERE user_id = $1`, [uid(3), B]);
      const rows = await logs();
      expect(rows.map((r) => [r.account_id, r.action, r.event_type])).toEqual([
        [A, "member.removed", "deleted"],
        [B, "member.joined", "created"],
      ]);
      expect(rows[0].metadata).toMatchObject({ role: "agent", to_account_id: B });
      expect(rows[1].metadata).toMatchObject({ role: "owner", from_account_id: A });
    });

    it("desativar/reativar (profiles.status da 242): sem a coluna nada acontece; com ela, deactivated/reactivated", async () => {
      await addProfile(4, "agent");
      await db.exec(`DELETE FROM wacrm.audit_logs`);
      await db.query(`UPDATE wacrm.profiles SET full_name = 'X' WHERE user_id = $1`, [uid(4)]);
      expect(await logs()).toEqual([]);

      await db.exec(`ALTER TABLE wacrm.profiles ADD COLUMN status text NOT NULL DEFAULT 'active'`);
      try {
        await db.query(`UPDATE wacrm.profiles SET status = 'disabled' WHERE user_id = $1`, [uid(4)]);
        await db.query(`UPDATE wacrm.profiles SET status = 'active' WHERE user_id = $1`, [uid(4)]);
        expect((await logs()).map((r) => r.action)).toEqual(["member.deactivated", "member.reactivated"]);
      } finally {
        await db.exec(`ALTER TABLE wacrm.profiles DROP COLUMN status`);
      }
    });
  });

  describe("propriedade e organização", () => {
    it("transferência: ownership.transferred com antes/depois e os nomes", async () => {
      await addProfile(1, "owner", A, "Dona");
      await addProfile(2, "admin", A, "Admin");
      await db.exec(`DELETE FROM wacrm.audit_logs`);
      await db.query(`UPDATE wacrm.accounts SET owner_user_id = $2 WHERE id = $1`, [A, uid(2)]);
      const rows = await logs();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: "ownership.transferred", resource_type: "account", account_id: A });
      expect(rows[0].changes?.owner_user_id).toEqual({ before: uid(1), after: uid(2) });
      expect(rows[0].summary).toBe("Propriedade da organização transferida de Dona para Admin");
    });

    it("a transferência real (dois perfis trocam de papel + dono) deixa 2 role_changed e 1 ownership.transferred", async () => {
      await addProfile(1, "owner", A, "Dona");
      await addProfile(2, "admin", A, "Admin");
      await db.exec(`DELETE FROM wacrm.audit_logs`);
      await db.exec(`
        UPDATE wacrm.profiles SET account_role = 'admin' WHERE user_id = '${uid(1)}';
        UPDATE wacrm.profiles SET account_role = 'owner' WHERE user_id = '${uid(2)}';
        UPDATE wacrm.accounts SET owner_user_id = '${uid(2)}' WHERE id = '${A}';
      `);
      expect((await logs()).map((r) => r.action).sort()).toEqual(["member.role_changed", "member.role_changed", "ownership.transferred"]);
    });

    it("renomear grava account.renamed; outra coluna não grava nada", async () => {
      await db.query(`UPDATE wacrm.accounts SET name = 'Nova Conta' WHERE id = $1`, [A]);
      const rows = await logs();
      expect(rows.map((r) => r.action)).toEqual(["account.renamed"]);
      expect(rows[0].changes?.name).toEqual({ before: "Conta A", after: "Nova Conta" });
    });
  });

  describe("convites", () => {
    const TOKEN_HASH = "hash-secreto-do-token-0123456789";

    it("criado → aceito; e revogado (convite pendente apagado); sem NENHUM dado do token", async () => {
      await addProfile(1, "owner", A, "Dona");
      await addProfile(5, "agent", B, "Convidado");
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO wacrm.account_invitations (account_id, token_hash, role, created_by_user_id, label, expires_at)
         VALUES ($1, $2, 'agent', $3, 'Convite Maria', now() + interval '7 days') RETURNING id`,
        [A, TOKEN_HASH, uid(1)],
      );
      await db.query(`UPDATE wacrm.account_invitations SET accepted_at = now(), accepted_by_user_id = $2 WHERE id = $1`, [rows[0].id, uid(5)]);
      const second = await db.query<{ id: string }>(
        `INSERT INTO wacrm.account_invitations (account_id, token_hash, role, created_by_user_id, expires_at)
         VALUES ($1, 'outro-hash', 'viewer', $2, now() + interval '7 days') RETURNING id`,
        [A, uid(1)],
      );
      await db.query(`DELETE FROM wacrm.account_invitations WHERE id = $1`, [second.rows[0].id]);

      const events = await logs(`resource_type = 'invitation'`);
      expect(events.map((r) => r.action)).toEqual(["invitation.created", "invitation.accepted", "invitation.created", "invitation.revoked"]);
      expect(events[0].summary).toBe("Convite criado para o papel agent por Dona");
      expect(events[0].metadata).toMatchObject({ role: "agent", created_by_user_id: uid(1) });
      expect(events[1].summary).toBe("Convite aceito por Convidado (papel agent)");
      expect(events[1].metadata).toMatchObject({ accepted_by_user_id: uid(5), role: "agent" });
      expect(events[3]).toMatchObject({ event_type: "deleted", account_id: A });
      expect(JSON.stringify(await logs())).not.toMatch(/hash-secreto|outro-hash|token_hash/);
    });

    it("apagar convite JÁ aceito (limpeza) não vira revogação", async () => {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO wacrm.account_invitations (account_id, token_hash, role, expires_at, accepted_at) VALUES ($1, 'h3', 'agent', now() + interval '1 day', now()) RETURNING id`,
        [A],
      );
      await db.exec(`DELETE FROM wacrm.audit_logs`);
      await db.query(`DELETE FROM wacrm.account_invitations WHERE id = $1`, [rows[0].id]);
      expect(await logs()).toEqual([]);
    });
  });

  describe("papéis personalizados", () => {
    it("criar, mexer nas permissões (diff por papel e comando), renomear e apagar", async () => {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO wacrm.account_roles (account_id, key, name, kind, rank, compat_role) VALUES ($1, 'so_responde', 'Só responde', 'custom', 2, 'agent') RETURNING id`,
        [A],
      );
      const id = rows[0].id;
      await db.query(`INSERT INTO wacrm.role_permissions (role_id, permission) VALUES ($1, 'inbox.view'), ($1, 'inbox.reply')`, [id]);
      await db.query(`DELETE FROM wacrm.role_permissions WHERE role_id = $1 AND permission = 'inbox.reply'`, [id]);
      await db.query(`UPDATE wacrm.account_roles SET name = 'Só responde 2' WHERE id = $1`, [id]);
      await db.query(`DELETE FROM wacrm.account_roles WHERE id = $1`, [id]);

      const events = await logs(`resource_type = 'role'`);
      expect(events.map((r) => r.action)).toEqual([
        "role.created",
        "role.permissions_changed",
        "role.permissions_changed",
        "role.updated",
        "role.deleted", // a exclusão em cascata das permissões NÃO gera evento extra (o papel já não existe)
      ]);
      expect(events[1].metadata).toEqual({ added: ["inbox.reply", "inbox.view"], removed: [] });
      expect(events[2].metadata).toEqual({ added: [], removed: ["inbox.reply"] });
      expect(events[3].changes?.name).toEqual({ before: "Só responde", after: "Só responde 2" });
      expect(events.every((r) => r.account_id === A)).toBe(true);
    });

    it("papéis de SISTEMA não geram evento (mesmo se alguém mexer como superusuário)", async () => {
      await db.exec(`DELETE FROM wacrm.audit_logs`);
      await db.exec(`UPDATE wacrm.account_roles SET description = 'x' WHERE account_id IS NULL AND key = 'viewer'`);
      await db.query(`DELETE FROM wacrm.role_permissions WHERE role_id = $1 AND permission = 'contacts.view'`, [await roleId("viewer")]);
      expect(await logs()).toEqual([]);
    });
  });

  describe("robustez", () => {
    it("falha na auditoria NÃO derruba a escrita original", async () => {
      await addProfile(2, "agent");
      await db.exec(`ALTER TABLE wacrm.audit_logs ADD CONSTRAINT boom CHECK (action IS DISTINCT FROM 'member.role_changed')`);
      await db.query(`UPDATE wacrm.profiles SET account_role = 'viewer' WHERE user_id = $1`, [uid(2)]);
      expect((await db.query<{ r: string }>(`SELECT account_role::text AS r FROM wacrm.profiles WHERE user_id = $1`, [uid(2)])).rows[0].r).toBe("viewer");
    });

    it("excluir a organização com convite pendente (cascata) funciona", async () => {
      await db.query(`INSERT INTO wacrm.account_invitations (account_id, token_hash, role, expires_at) VALUES ($1, 'h4', 'agent', now() + interval '1 day')`, [B]);
      await db.query(`DELETE FROM wacrm.accounts WHERE id = $1`, [B]);
      expect((await db.query(`SELECT 1 FROM wacrm.accounts WHERE id = $1`, [B])).rows).toHaveLength(0);
      await db.exec(`INSERT INTO wacrm.accounts (id, name, owner_user_id) VALUES ('${B}', 'Conta B', '${uid(9)}')`);
    });

    it("idempotente: reaplicar a 248 não duplica trigger nem evento", async () => {
      const count = async () => (await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM pg_trigger WHERE tgname LIKE 'trg_audit_%' AND NOT tgisinternal`)).rows[0].c;
      const before = await count();
      await db.exec(migration("248_audit_roles.sql"));
      expect(await count()).toBe(before);
      await addProfile(2, "agent");
      await db.exec(`DELETE FROM wacrm.audit_logs`);
      await db.query(`UPDATE wacrm.profiles SET account_role = 'viewer' WHERE user_id = $1`, [uid(2)]);
      expect(await logs()).toHaveLength(1);
    });
  });
});

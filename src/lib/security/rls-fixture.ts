// Fixture de PGlite para os testes de RLS da fase 2 (migrations 323+): contas, perfis dos 5 papéis de sistema + papéis personalizados,
// com as migrations REAIS 169, 140 (is_account_member com supervisor, current_user_role/current_user_team_ids), 240, 241 e 241b.
// Cada teste de lote cria as tabelas do domínio, instala as policies "antes" (texto das migrations originais), tira o retrato, aplica a
// migration nova e tira o retrato "depois": nos papéis de sistema os dois retratos têm que ser IGUAIS.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

export const migration = (file: string) => readFileSync(resolve(process.cwd(), "supabase/migrations", file), "utf8").replace(/NOTIFY pgrst[^;]*;/g, "");
export const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

export const ACC = id(1);
export const ACC_B = id(2);
export const T1 = id(201);
export const T2 = id(202);

/** Usuários: 5 papéis de sistema (+ um 2º operador da equipe T2), um usuário de OUTRA conta e os personalizados passados a createRolesDb. */
export const U: Record<string, string> = {
  owner: id(101),
  admin: id(102),
  supervisor: id(103),
  agent: id(104),
  viewer: id(105),
  agent2: id(106),
  other: id(107),
};
export const SYSTEM = ["owner", "admin", "supervisor", "agent", "viewer", "agent2"] as const;
export type SystemWho = (typeof SYSTEM)[number];

const BOOTSTRAP = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA wacrm; CREATE SCHEMA auth;
  GRANT USAGE ON SCHEMA wacrm, auth TO anon, authenticated, service_role;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
  CREATE TYPE wacrm.account_role_enum AS ENUM ('owner', 'admin', 'supervisor', 'agent', 'viewer');
  CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL DEFAULT 'conta', owner_user_id uuid);
  CREATE TABLE wacrm.profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE, account_id uuid REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
    account_role wacrm.account_role_enum NOT NULL, full_name text, email text, avatar_url text, updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE FUNCTION wacrm.current_account_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public
    AS $$ SELECT p.account_id FROM wacrm.profiles p WHERE p.user_id = auth.uid() LIMIT 1 $$;
  INSERT INTO wacrm.accounts (id, name) VALUES ('${ACC}', 'A'), ('${ACC_B}', 'B');
  CREATE TABLE wacrm.teams (id uuid PRIMARY KEY, account_id uuid);
  CREATE TABLE wacrm.team_members (team_id uuid, user_id uuid);
  CREATE TABLE wacrm.whatsapp_config (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, team_id uuid);
  CREATE TABLE wacrm.conversations (id uuid PRIMARY KEY, account_id uuid, team_id uuid, assigned_agent_id uuid, status text, created_at timestamptz DEFAULT now());
  CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
  CREATE FUNCTION wacrm.is_account_member(target_account_id uuid, min_role wacrm.account_role_enum DEFAULT 'viewer') RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT false $$;
`;

export interface CustomRole {
  /** chave do usuário em U (ex.: "semContatos") */
  who: string;
  /** papel de sistema que o `compat_role` espelha (o menor que contém o conjunto) */
  compat: "owner" | "admin" | "supervisor" | "agent" | "viewer";
  permissions: string[];
}

export async function createRolesDb(custom: CustomRole[] = []): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(BOOTSTRAP);
  await db.exec(migration("169_profiles_lock_privileged_columns.sql"));
  await db.exec(migration("140_supervisor_role_access.sql"));
  await db.exec(migration("240_roles_foundation.sql"));
  await db.exec(migration("241_roles_functions.sql"));
  await db.exec(migration("241b_profiles_role_id_idx.sql"));
  await db.exec(`GRANT SELECT ON wacrm.profiles, wacrm.accounts, wacrm.teams, wacrm.team_members, wacrm.account_roles, wacrm.role_permissions, wacrm.permission_catalog TO authenticated`);

  // perfis: a trigger da 240 preenche role_id a partir do account_role
  const role: Record<string, string> = { owner: "owner", admin: "admin", supervisor: "supervisor", agent: "agent", viewer: "viewer", agent2: "agent" };
  for (const w of SYSTEM) await db.query(`INSERT INTO wacrm.profiles (user_id, account_id, account_role) VALUES ($1, $2, $3::wacrm.account_role_enum)`, [U[w], ACC, role[w]]);
  await db.query(`INSERT INTO wacrm.profiles (user_id, account_id, account_role) VALUES ($1, $2, 'admin')`, [U.other, ACC_B]);
  for (const c of custom) {
    if (!U[c.who]) U[c.who] = id(300 + Object.keys(U).length);
    const rid = (await db.query<{ id: string }>(`INSERT INTO wacrm.account_roles (account_id, key, name, kind, rank, compat_role) VALUES ($1, $2, $2, 'custom', 2, $3) RETURNING id`, [ACC, c.who, c.compat])).rows[0].id;
    for (const p of c.permissions) await db.query(`INSERT INTO wacrm.role_permissions (role_id, permission) VALUES ($1, $2)`, [rid, p]);
    await db.query(`INSERT INTO wacrm.profiles (user_id, account_id, account_role) VALUES ($1, $2, 'viewer')`, [U[c.who], ACC]);
    await db.query(`UPDATE wacrm.profiles SET role_id = $2 WHERE user_id = $1`, [U[c.who], rid]);
  }
  await db.exec(`
    INSERT INTO wacrm.teams VALUES ('${T1}', '${ACC}'), ('${T2}', '${ACC}');
    INSERT INTO wacrm.team_members VALUES ('${T1}', '${U.supervisor}'), ('${T1}', '${U.agent}'), ('${T2}', '${U.agent2}');
  `);
  return db;
}

/** Roda `sql` como `who` (role authenticated + auth.uid()). Sempre volta ao superusuário. */
export async function asUser<T = Record<string, unknown>>(db: PGlite, who: string, sql: string): Promise<T[]> {
  await db.exec("SET ROLE authenticated");
  await db.exec(`SELECT set_config('test.uid', '${U[who]}', false)`);
  try {
    return (await db.query<T>(sql)).rows;
  } finally {
    await db.exec("RESET ROLE");
  }
}

/**
 * SQL EXECUTÁVEL do bloco `-- ROLLBACK:` do cabeçalho de uma migration (linhas `--` até a régua `-- ====`): o mesmo critério do teste da rodada de deploy
 * (cada comando numa linha que começa por uma palavra SQL; DO $$ … $$ pode ter várias linhas). Prosa é descartada.
 */
export function headerRollback(file: string): string {
  const lines = migration(file).split("\n");
  const start = lines.findIndex((l) => /^--\s*ROLLBACK/i.test(l));
  if (start < 0) throw new Error(`${file}: sem linha ROLLBACK no cabeçalho`);
  const raw = [lines[start].replace(/^--\s*ROLLBACK[^:]*:/i, "")];
  for (let i = start + 1; i < lines.length && lines[i].startsWith("--") && !/^--\s*={5,}/.test(lines[i]); i++) raw.push(lines[i]);
  const SQL_START = /^(BEGIN|COMMIT|DROP|DELETE|ALTER|DO|UPDATE|CREATE|REVOKE|GRANT|END|FOR|EXECUTE|SELECT)\b/i;
  const kept: string[] = [];
  let inDollar = false;
  for (const line of raw) {
    const t = line.replace(/^--/, "").trim();
    if (!t) continue;
    if (!inDollar && !SQL_START.test(t)) continue;
    kept.push(t);
    if (((t.match(/\$\$/g) ?? []).length % 2) === 1) inDollar = !inDollar;
  }
  return kept.join("\n");
}

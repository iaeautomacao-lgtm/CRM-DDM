// Esquema-base da "rodada de deploy" (deploy-round.sql.test.ts): só o que a v2 JÁ tem em produção ANTES das migrations novas,
// reduzido ao que elas leem (pré-checks, FKs, colunas de funções LANGUAGE sql, que o Postgres valida na criação).
// NÃO é a fonte de verdade do schema vivo (CLAUDE.md: confira no Supabase): se uma migration nova passar a depender de outra coisa
// que já existe em produção, acrescente aqui — se depender de algo que só uma migration NOVA cria, a ordem está errada.
// Regra: nada aqui pode ser criado por uma migration da rodada (senão o teste de ordem não detectaria dependência de migration posterior).

/** wacrm.user_sessions como a 290 (já em produção) a criou; também é o que "reaplicar a 290" (rollback da 315) executa. */
export const USER_SESSIONS_290 = `
CREATE OR REPLACE FUNCTION wacrm.user_sessions(p_user uuid)
RETURNS TABLE (id uuid, created_at timestamptz, updated_at timestamptz, user_agent text, ip text, aal text, not_after timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, auth, public
AS $$
  SELECT s.id, s.created_at,
         coalesce((to_jsonb(s) ->> 'refreshed_at')::timestamptz, s.updated_at),
         left(to_jsonb(s) ->> 'user_agent', 300), to_jsonb(s) ->> 'ip', to_jsonb(s) ->> 'aal',
         (to_jsonb(s) ->> 'not_after')::timestamptz
    FROM auth.sessions s
   WHERE s.user_id = p_user
   ORDER BY coalesce((to_jsonb(s) ->> 'refreshed_at')::timestamptz, s.updated_at) DESC NULLS LAST
   LIMIT 100
$$;
`;

export const BASELINE_SQL = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth; CREATE SCHEMA wacrm;
GRANT USAGE ON SCHEMA auth, wacrm TO anon, authenticated, service_role;

CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, last_sign_in_at timestamptz);
CREATE TABLE auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, created_at timestamptz DEFAULT now(),
  updated_at timestamptz, refreshed_at timestamp, user_agent text, ip text, aal text, not_after timestamptz);
CREATE TABLE auth.mfa_factors (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, status text, factor_type text);
CREATE INDEX mfa_factors_user_id_idx ON auth.mfa_factors (user_id);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('test.jwt', true), ''), '{}')::jsonb $$;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.jwt() TO anon, authenticated, service_role;

CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY, applied_at timestamptz DEFAULT now());
CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE wacrm.profiles (user_id uuid PRIMARY KEY, account_id uuid REFERENCES wacrm.accounts(id), account_role text NOT NULL DEFAULT 'agent', full_name text, avatar_url text);
CREATE TABLE wacrm.member_presence (user_id uuid PRIMARY KEY, account_id uuid, last_seen_at timestamptz);
CREATE TABLE wacrm.teams (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES wacrm.accounts(id));
CREATE TABLE wacrm.team_members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), team_id uuid NOT NULL REFERENCES wacrm.teams(id), user_id uuid NOT NULL);
CREATE TABLE wacrm.contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid);
CREATE TABLE wacrm.conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES wacrm.accounts(id), contact_id uuid,
  status text DEFAULT 'open', assigned_agent_id uuid, team_id uuid, created_at timestamptz DEFAULT now(), first_response_at timestamptz,
  closed_at timestamptz, last_customer_message_at timestamptz);
CREATE TABLE wacrm.messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid REFERENCES wacrm.conversations(id),
  sender_type text NOT NULL, sender_id uuid, created_at timestamptz DEFAULT now());
CREATE TABLE wacrm.conversation_assignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, conversation_id uuid NOT NULL,
  from_agent_id uuid, to_agent_id uuid, from_team_id uuid, to_team_id uuid, actor_id uuid, reason text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE wacrm.export_history (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES wacrm.accounts(id), file_name text);
CREATE TABLE wacrm.internal_messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES wacrm.accounts(id),
  sender_id uuid NOT NULL REFERENCES auth.users(id), recipient_id uuid NOT NULL REFERENCES auth.users(id), content text NOT NULL, media_type text,
  read_at timestamptz, created_at timestamptz DEFAULT now());
CREATE TABLE wacrm.quick_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  shortcut text NOT NULL CHECK (shortcut ~ '^[a-z0-9_-]{1,30}$'), title text NOT NULL, content text NOT NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, shortcut));
CREATE TABLE wacrm.flow_nodes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), node_type text NOT NULL,
  CONSTRAINT flow_nodes_node_type_check CHECK (node_type IN ('start'::text, 'send_message'::text, 'condition'::text, 'end'::text)));
CREATE TABLE wacrm.disp_message_queue (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sent_at timestamptz);
CREATE TABLE wacrm.billing_rulers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, name text, channel_id uuid,
  priority integer DEFAULT 0, active boolean DEFAULT true, dry_run boolean DEFAULT false);
CREATE TABLE wacrm.billing_ruler_steps (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, ruler_id uuid, position integer, offset_days integer, active boolean);
CREATE TABLE wacrm.billing_enrollments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, ruler_id uuid, status text, stop_reason text, stopped_at timestamptz);
CREATE TABLE wacrm.billing_step_sends (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, step_id uuid, enrollment_id uuid, contact_id uuid,
  queue_item_id uuid, status text, reserved_at timestamptz, updated_at timestamptz);
CREATE TABLE wacrm.billing_sync_state (account_id uuid NOT NULL, source text NOT NULL, last_success_at timestamptz, last_run_at timestamptz, last_error text);
CREATE TABLE wacrm.billing_debts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, status text);

CREATE FUNCTION wacrm.current_account_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
  AS $$ SELECT account_id FROM wacrm.profiles WHERE user_id = auth.uid() LIMIT 1 $$;
CREATE FUNCTION wacrm.is_account_member(p_account uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  AS $$ SELECT EXISTS (SELECT 1 FROM wacrm.profiles WHERE user_id = auth.uid() AND account_id = p_account) $$;
CREATE FUNCTION wacrm.is_account_member(p_account uuid, p_min text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  AS $$ SELECT EXISTS (SELECT 1 FROM wacrm.profiles WHERE user_id = auth.uid() AND account_id = p_account
          AND CASE account_role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'supervisor' THEN 2 ELSE 1 END
            >= CASE p_min WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'supervisor' THEN 2 ELSE 1 END) $$;

ALTER TABLE wacrm.quick_replies ENABLE ROW LEVEL SECURITY;
CREATE POLICY quick_replies_select ON wacrm.quick_replies FOR SELECT USING (wacrm.is_account_member(account_id));
CREATE POLICY quick_replies_insert ON wacrm.quick_replies FOR INSERT WITH CHECK (wacrm.is_account_member(account_id, 'admin'));
CREATE POLICY quick_replies_update ON wacrm.quick_replies FOR UPDATE USING (wacrm.is_account_member(account_id, 'admin')) WITH CHECK (wacrm.is_account_member(account_id, 'admin'));
CREATE POLICY quick_replies_delete ON wacrm.quick_replies FOR DELETE USING (wacrm.is_account_member(account_id, 'admin'));
ALTER TABLE wacrm.internal_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY internal_messages_own ON wacrm.internal_messages FOR ALL USING (sender_id = auth.uid() OR recipient_id = auth.uid());
ALTER TABLE wacrm.conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY conversations_member ON wacrm.conversations FOR ALL USING (wacrm.is_account_member(account_id));
ALTER TABLE wacrm.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY profiles_own ON wacrm.profiles FOR SELECT USING (user_id = auth.uid());
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA wacrm TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA wacrm TO service_role;
-- profiles: a 169 trocou o UPDATE de tabela inteira por UPDATE só nas colunas que o usuário edita (full_name, avatar_url).
REVOKE UPDATE ON wacrm.profiles FROM authenticated;
GRANT UPDATE (full_name, avatar_url) ON wacrm.profiles TO authenticated;
${USER_SESSIONS_290}
`;

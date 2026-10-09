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

/** Migrations REAIS já aplicadas em produção que a baseline reaproveita (papéis/catálogo/has_perm e supervisor), em ordem. */
export const BASELINE_REAL_MIGRATIONS = [
  "169_profiles_lock_privileged_columns.sql",
  "240_roles_foundation.sql",
  "241_roles_functions.sql",
  "241b_profiles_role_id_idx.sql",
  "276_billing_permissions.sql",
  "140_supervisor_role_access.sql",
  "143_supervisor_report_scope.sql",
] as const;

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
CREATE TYPE wacrm.account_role_enum AS ENUM ('owner', 'admin', 'supervisor', 'agent', 'viewer');
CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text DEFAULT 'conta', owner_user_id uuid);
CREATE TABLE wacrm.profiles (user_id uuid PRIMARY KEY, account_id uuid REFERENCES wacrm.accounts(id), account_role wacrm.account_role_enum NOT NULL DEFAULT 'agent', full_name text, avatar_url text, email text, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE wacrm.member_presence (user_id uuid PRIMARY KEY, account_id uuid, last_seen_at timestamptz);
CREATE TABLE wacrm.teams (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES wacrm.accounts(id));
CREATE TABLE wacrm.team_members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), team_id uuid NOT NULL REFERENCES wacrm.teams(id), user_id uuid NOT NULL);
CREATE TABLE wacrm.tags (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, name text, kind text NOT NULL DEFAULT 'contact');
CREATE TABLE wacrm.contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid);
CREATE TABLE wacrm.conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES wacrm.accounts(id), contact_id uuid,
  status text DEFAULT 'open', assigned_agent_id uuid, team_id uuid, created_at timestamptz DEFAULT now(), first_response_at timestamptz,
  closed_at timestamptz, last_customer_message_at timestamptz, outcome_tag_id uuid, outcome_source text, suggested_outcome_tag_id uuid, updated_at timestamptz DEFAULT now(), channel_type text);
CREATE TABLE wacrm.whatsapp_config (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES wacrm.accounts(id), team_id uuid);
CREATE TABLE wacrm.messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid REFERENCES wacrm.conversations(id),
  sender_type text NOT NULL, sender_id uuid, created_at timestamptz DEFAULT now(), account_id uuid, content_type text, content_text text, media_url text,
  template_name text, status text, reply_to_message_id uuid, campaign_id uuid);
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
-- is_account_member como a 017 criou (ranks owner 4 · admin 3 · agent 2 · viewer 1; a 140 acrescenta supervisor).
CREATE FUNCTION wacrm.is_account_member(target_account_id uuid, min_role wacrm.account_role_enum DEFAULT 'viewer') RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public
AS $$ SELECT EXISTS (SELECT 1 FROM wacrm.profiles p WHERE p.user_id = auth.uid() AND p.account_id = target_account_id
  AND CASE p.account_role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'agent' THEN 2 WHEN 'viewer' THEN 1 END
    >= CASE min_role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'agent' THEN 2 WHEN 'viewer' THEN 1 END) $$;
GRANT EXECUTE ON FUNCTION wacrm.is_account_member(uuid, wacrm.account_role_enum) TO authenticated, service_role;

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
-- Tabelas de contatos (a 323 troca as policies de SELECT delas) com a policy de membership de hoje.
CREATE TABLE wacrm.custom_fields (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL);
CREATE TABLE wacrm.contact_tags (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid NOT NULL);
CREATE TABLE wacrm.contact_custom_values (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid NOT NULL);
CREATE TABLE wacrm.contact_import_variables (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid NOT NULL);
CREATE TABLE wacrm.contact_phones (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid NOT NULL);
CREATE TABLE wacrm.contact_notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, contact_id uuid);
CREATE TABLE wacrm.contact_identities (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, contact_id uuid);
ALTER TABLE wacrm.contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY contacts_select ON wacrm.contacts FOR SELECT USING (wacrm.is_account_member(account_id));
ALTER TABLE wacrm.tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY tags_select ON wacrm.tags FOR SELECT USING (wacrm.is_account_member(account_id));
ALTER TABLE wacrm.custom_fields ENABLE ROW LEVEL SECURITY;
CREATE POLICY custom_fields_select ON wacrm.custom_fields FOR SELECT USING (wacrm.is_account_member(account_id));
ALTER TABLE wacrm.contact_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY contact_notes_select ON wacrm.contact_notes FOR SELECT USING (wacrm.is_account_member(account_id));
ALTER TABLE wacrm.contact_identities ENABLE ROW LEVEL SECURITY;
CREATE POLICY contact_identities_select ON wacrm.contact_identities FOR SELECT TO authenticated USING (wacrm.is_account_member(account_id));
ALTER TABLE wacrm.contact_tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY contact_tags_select ON wacrm.contact_tags FOR SELECT USING (EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_tags.contact_id AND wacrm.is_account_member(c.account_id)));
ALTER TABLE wacrm.contact_custom_values ENABLE ROW LEVEL SECURITY;
CREATE POLICY contact_custom_values_select ON wacrm.contact_custom_values FOR SELECT USING (EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_custom_values.contact_id AND wacrm.is_account_member(c.account_id)));
ALTER TABLE wacrm.contact_phones ENABLE ROW LEVEL SECURITY;
CREATE POLICY contact_phones_select ON wacrm.contact_phones FOR SELECT USING (EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_phones.contact_id AND wacrm.is_account_member(c.account_id)));
ALTER TABLE wacrm.contact_import_variables ENABLE ROW LEVEL SECURITY;
CREATE POLICY contact_import_variables_select ON wacrm.contact_import_variables FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_import_variables.contact_id AND wacrm.is_account_member(c.account_id)));

-- RPCs de relatório (a 322 reescreve o guard is_account_member(p_account_id) pela definição VIVA). Aqui só reproduzem a ASSINATURA e o
-- número de ocorrências do guard que a 322 confere; a lógica de cada relatório não é o objeto deste teste.
CREATE FUNCTION wacrm.get_attendance_report_by_team(p_account_id uuid, p_from timestamptz, p_to timestamptz) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = wacrm, public
  AS $$ BEGIN IF NOT (TRUE AND is_account_member(p_account_id)) THEN RAISE EXCEPTION 'forbidden'; END IF; RETURN 0; END $$;
CREATE FUNCTION wacrm.get_attendance_report_by_agent(p_account_id uuid, p_from timestamptz, p_to timestamptz) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = wacrm, public
  AS $$ BEGIN IF NOT (TRUE AND is_account_member(p_account_id)) THEN RAISE EXCEPTION 'forbidden'; END IF; RETURN 0; END $$;
CREATE FUNCTION wacrm.get_attendance_summary(p_account_id uuid, p_from timestamptz, p_to timestamptz) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = wacrm, public
  AS $$ BEGIN IF NOT (TRUE AND is_account_member(p_account_id)) THEN RAISE EXCEPTION 'forbidden'; END IF; RETURN 0; END $$;
CREATE FUNCTION wacrm.get_conversations_report(p_account_id uuid, p_from timestamptz, p_to timestamptz, p_a text, p_b text, p_c uuid, p_d uuid, p_e text, p_f text, p_g integer, p_h integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = wacrm, public
  AS $$ BEGIN IF NOT (TRUE AND is_account_member(p_account_id)) THEN RAISE EXCEPTION 'forbidden'; END IF; RETURN 0; END $$;
CREATE FUNCTION wacrm.get_agent_sessions_report(p_account_id uuid, p_from timestamptz, p_to timestamptz, p_agent uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = wacrm, public
  AS $$ BEGIN IF NOT (TRUE AND is_account_member(p_account_id)) THEN RAISE EXCEPTION 'forbidden'; END IF; RETURN 0; END $$;
CREATE FUNCTION wacrm.report_tabulacoes(p_account_id uuid, p_from timestamptz, p_to timestamptz, p_team uuid, p_agent uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = wacrm, public
  AS $$ BEGIN IF NOT wacrm.is_account_member(p_account_id) THEN RAISE EXCEPTION 'forbidden'; END IF; IF NOT wacrm.is_account_member(p_account_id) THEN RAISE EXCEPTION 'forbidden'; END IF; RETURN 0; END $$;
CREATE FUNCTION wacrm.get_campaigns_for_report(p_account_id uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = wacrm, public
  AS $$ BEGIN IF NOT wacrm.is_account_member(p_account_id) THEN RAISE EXCEPTION 'forbidden'; END IF; RETURN 0; END $$;
CREATE FUNCTION wacrm.get_campaign_report_detail(p_account_id uuid, p_campaign uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = wacrm, public
  AS $$ BEGIN IF NOT wacrm.is_account_member(p_account_id) THEN RAISE EXCEPTION 'forbidden'; END IF; RETURN 0; END $$;
CREATE FUNCTION wacrm.get_campaign_queue_items(p_account_id uuid, p_campaign uuid, p_a text, p_b text, p_c integer, p_d integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = wacrm, public
  AS $$ BEGIN IF NOT wacrm.is_account_member(p_account_id) THEN RAISE EXCEPTION 'forbidden'; END IF; RETURN 0; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA wacrm TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA wacrm TO service_role;
-- profiles: a 169 trocou o UPDATE de tabela inteira por UPDATE só nas colunas que o usuário edita (full_name, avatar_url).
REVOKE UPDATE ON wacrm.profiles FROM authenticated;
GRANT UPDATE (full_name, avatar_url) ON wacrm.profiles TO authenticated;
${USER_SESSIONS_290}
`;

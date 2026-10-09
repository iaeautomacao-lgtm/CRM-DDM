-- ============================================================
-- 222_audit_contacts.sql   (PRD 14 — auditoria de contatos sem PII em claro, leve em importação em massa)
--
-- Decisão do dono (09/10): auditar contatos (name, phone, cpf, email [+ company, que já era auditada]), etiquetas e blacklist/opt-out
-- (INSERT/UPDATE/DELETE); guardar só os NOMES dos campos alterados + valor MASCARADO (nada de PII em claro); leitura por
-- admin/proprietário (RLS de audit_logs da 131 = audit.view, admin+).
--
-- O QUE MUDA em relação à 131 (que gravava before/after e, no DELETE, phone/email EM CLARO, e usava o nome/telefone como rótulo):
--   * trg_audit_contacts (por LINHA) → 3 triggers por STATEMENT com tabelas de transição (INSERT / UPDATE / DELETE).
--   * trg_audit_contact_tags (por linha) → 2 triggers por statement (INSERT / DELETE).
--   * NOVO: trg_audit_blacklist_* (INSERT / UPDATE / DELETE) — opt-out e bloqueios. mensagem_detectada (texto do cliente) NUNCA é lida.
--   * Máscara única em SQL (wacrm.audit_mask_value): nome → "J*** S***", telefone → "****1234", CPF → "***.***.***-12",
--     e-mail → "m***@dominio", empresa → "A***". O rótulo do recurso também é mascarado.
--   * IMPORTAÇÃO EM MASSA: statement com ≤ 20 linhas gera 1 evento por contato (como antes); com > 20 gera UM evento agregado
--     por conta (`contact.bulk_created` / `bulk_updated` / `bulk_deleted`, `contact.bulk_tag_added/removed`, `blacklist.bulk_*`)
--     com contagens (e, no update, quantas linhas mudaram cada campo) e até 5 ids de amostra. Custo = 1 INSERT em audit_logs por statement,
--     não 1 por linha (o gargalo de uma importação de 100 mil).
-- Auditoria nunca derruba a escrita original (EXCEPTION → RAISE WARNING). Ator/IP/origem vêm de audit_actor() (131).
-- As funções antigas da 131 (audit_contacts_changes, audit_contact_tags_changes) NÃO são removidas: só deixam de ser usadas (rollback simples).
-- Eventos antigos já gravados com valor em claro NÃO são alterados aqui (decisão de dados/retenção do dono — fora desta migration).
-- "opt-out" não é coluna de contacts: o opt-out do contato é a linha em wacrm.blacklist (motivo opt_out/reclamacao etc.).
--
-- PRÉ-CHECK (rodar ANTES; o schema vivo manda — blacklist não tem CREATE TABLE nas migrations):
--   SELECT to_regprocedure('wacrm.audit_write(uuid,text,text,uuid,text,text,text,jsonb,jsonb)');            -- não nulo (131)
--   SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='blacklist'
--      AND column_name IN ('id','account_id','telefone','motivo','bloqueado_por');                             -- id pode ser uuid ou bigint (a migration trata os dois)
--   SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='contacts'
--      AND column_name IN ('id','account_id','name','phone','email','cpf','company');                          -- 7 linhas
--   SELECT tgname FROM pg_trigger WHERE tgrelid IN ('wacrm.contacts'::regclass,'wacrm.contact_tags'::regclass) AND NOT tgisinternal;
-- VERIFICAÇÃO (depois): SELECT tgname FROM pg_trigger WHERE tgname LIKE 'trg_audit_contacts_%' OR tgname LIKE 'trg_audit_blacklist_%'
--      OR tgname LIKE 'trg_audit_contact_tags_%' ORDER BY 1;  -- e importe/edite um contato de teste: SELECT action, summary, changes FROM wacrm.audit_logs ORDER BY created_at DESC LIMIT 5;
-- ORDEM: antes ou depois do deploy (o app não depende dela). Idempotente. Em tabela de 100 mil+ contatos o CREATE TRIGGER é instantâneo (não reescreve dados).
-- ROLLBACK:
--   BEGIN;
--   DROP TRIGGER IF EXISTS trg_audit_contacts_ins ON wacrm.contacts;  DROP TRIGGER IF EXISTS trg_audit_contacts_upd ON wacrm.contacts;
--   DROP TRIGGER IF EXISTS trg_audit_contacts_del ON wacrm.contacts;
--   DROP TRIGGER IF EXISTS trg_audit_contact_tags_ins ON wacrm.contact_tags; DROP TRIGGER IF EXISTS trg_audit_contact_tags_del ON wacrm.contact_tags;
--   DO $r$ BEGIN IF to_regclass('wacrm.blacklist') IS NOT NULL THEN
--     DROP TRIGGER IF EXISTS trg_audit_blacklist_ins ON wacrm.blacklist; DROP TRIGGER IF EXISTS trg_audit_blacklist_upd ON wacrm.blacklist;
--     DROP TRIGGER IF EXISTS trg_audit_blacklist_del ON wacrm.blacklist; END IF; END $r$;
--   CREATE TRIGGER trg_audit_contacts AFTER INSERT OR UPDATE OR DELETE ON wacrm.contacts FOR EACH ROW EXECUTE FUNCTION wacrm.audit_contacts_changes();
--   CREATE TRIGGER trg_audit_contact_tags AFTER INSERT OR DELETE ON wacrm.contact_tags FOR EACH ROW EXECUTE FUNCTION wacrm.audit_contact_tags_changes();
--   DROP FUNCTION IF EXISTS wacrm.audit_contacts_insert_stmt(), wacrm.audit_contacts_update_stmt(), wacrm.audit_contacts_delete_stmt(),
--     wacrm.audit_contact_tags_insert_stmt(), wacrm.audit_contact_tags_delete_stmt(), wacrm.audit_blacklist_insert_stmt(),
--     wacrm.audit_blacklist_update_stmt(), wacrm.audit_blacklist_delete_stmt(), wacrm.audit_mask_value(text, text),
--     wacrm.audit_bulk_threshold(), wacrm.audit_resource_uuid(text);
--   DELETE FROM wacrm.schema_migrations WHERE version = '222_audit_contacts';
--   COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('wacrm.audit_write(uuid,text,text,uuid,text,text,text,jsonb,jsonb)') IS NULL THEN
    RAISE EXCEPTION '222: falta a auditoria da migration 131 (audit_write)';
  END IF;
  IF to_regclass('wacrm.audit_logs') IS NULL OR to_regclass('wacrm.contacts') IS NULL OR to_regclass('wacrm.contact_tags') IS NULL
     OR to_regclass('wacrm.tags') IS NULL THEN
    RAISE EXCEPTION '222: faltam wacrm.audit_logs/contacts/contact_tags/tags';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'wacrm' AND table_name = 'contacts'
        AND column_name IN ('id','account_id','name','phone','email','cpf','company')) <> 7 THEN
    RAISE EXCEPTION '222: wacrm.contacts precisa de id, account_id, name, phone, email, cpf e company — confira o schema vivo';
  END IF;
END $$;

-- ---- máscara única ---------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wacrm.audit_mask_value(p_field text, p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN p_value IS NULL THEN NULL
    WHEN btrim(p_value) = '' THEN ''
    WHEN p_field = 'phone' THEN
      CASE WHEN length(regexp_replace(p_value, '\D', '', 'g')) <= 4 THEN '****'
           ELSE '****' || right(regexp_replace(p_value, '\D', '', 'g'), 4) END
    WHEN p_field = 'cpf' THEN
      CASE WHEN length(regexp_replace(p_value, '\D', '', 'g')) = 11
           THEN '***.***.***-' || right(regexp_replace(p_value, '\D', '', 'g'), 2) ELSE '***' END
    WHEN p_field = 'email' THEN
      CASE WHEN position('@' IN p_value) > 1 THEN left(p_value, 1) || '***' || substr(p_value, position('@' IN p_value)) ELSE '***' END
    WHEN p_field IN ('name', 'company') THEN regexp_replace(btrim(p_value), '(\S)\S*', '\1***', 'g')
    ELSE '***'
  END
$$;

-- Limite entre "um evento por linha" e "um evento agregado por conta" (statement com mais linhas que isto é tratado como lote).
CREATE OR REPLACE FUNCTION wacrm.audit_bulk_threshold() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 20 $$;

-- audit_write exige uuid: blacklist.id pode ser bigint no schema vivo → uuid determinístico a partir do texto do id.
CREATE OR REPLACE FUNCTION wacrm.audit_resource_uuid(p_id text)
RETURNS uuid LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN p_id::uuid;
EXCEPTION WHEN others THEN
  RETURN md5(coalesce(p_id, ''))::uuid;
END $$;

-- ---- contatos: INSERT ------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wacrm.audit_contacts_insert_stmt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
DECLARE
  r record;
  v_n integer;
  v_label text;
BEGIN
  SELECT count(*) INTO v_n FROM new_rows;
  IF v_n = 0 THEN RETURN NULL; END IF;
  IF v_n <= wacrm.audit_bulk_threshold() THEN
    FOR r IN SELECT id, account_id, name, phone FROM new_rows LOOP
      v_label := coalesce(nullif(wacrm.audit_mask_value('name', r.name), ''), wacrm.audit_mask_value('phone', r.phone), 'Contato');
      PERFORM wacrm.audit_write(r.account_id, 'created', 'contact', r.id, v_label, 'contact.created', format('Contato %s criado', v_label));
    END LOOP;
  ELSE
    FOR r IN SELECT account_id, count(*) AS n, (array_agg(id))[1:5] AS sample FROM new_rows WHERE account_id IS NOT NULL GROUP BY account_id LOOP
      PERFORM wacrm.audit_write(r.account_id, 'created', 'contact', gen_random_uuid(), 'Lote de contatos', 'contact.bulk_created',
        format('%s contatos criados em lote', r.n), NULL, jsonb_build_object('count', r.n, 'sample_ids', to_jsonb(r.sample)));
    END LOOP;
  END IF;
  RETURN NULL;
EXCEPTION WHEN others THEN
  RAISE WARNING 'audit_contacts_insert_stmt falhou: %', SQLERRM;  -- auditoria nunca derruba a escrita original
  RETURN NULL;
END;
$$;

-- ---- contatos: UPDATE (name, phone, email, cpf, company) --------------------------------------------------------------
CREATE OR REPLACE FUNCTION wacrm.audit_contacts_update_stmt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
DECLARE
  r record;
  v_n integer;
  v_changes jsonb;
  v_label text;
BEGIN
  -- Só as linhas em que algum campo auditado mudou (updates de last_message_at & cia. saem aqui sem custo).
  SELECT count(*) INTO v_n
    FROM new_rows n JOIN old_rows o ON o.id = n.id
   WHERE (o.name, o.phone, o.email, o.cpf, o.company) IS DISTINCT FROM (n.name, n.phone, n.email, n.cpf, n.company);
  IF v_n = 0 THEN RETURN NULL; END IF;

  IF v_n <= wacrm.audit_bulk_threshold() THEN
    FOR r IN
      SELECT n.id, n.account_id, n.name, n.phone, o.name AS o_name, o.phone AS o_phone, o.email AS o_email, o.cpf AS o_cpf, o.company AS o_company,
             n.email, n.cpf, n.company
        FROM new_rows n JOIN old_rows o ON o.id = n.id
       WHERE (o.name, o.phone, o.email, o.cpf, o.company) IS DISTINCT FROM (n.name, n.phone, n.email, n.cpf, n.company)
    LOOP
      v_changes := '{}'::jsonb;
      IF r.o_name    IS DISTINCT FROM r.name    THEN v_changes := v_changes || jsonb_build_object('name',    jsonb_build_object('before', wacrm.audit_mask_value('name', r.o_name),       'after', wacrm.audit_mask_value('name', r.name))); END IF;
      IF r.o_phone   IS DISTINCT FROM r.phone   THEN v_changes := v_changes || jsonb_build_object('phone',   jsonb_build_object('before', wacrm.audit_mask_value('phone', r.o_phone),     'after', wacrm.audit_mask_value('phone', r.phone))); END IF;
      IF r.o_email   IS DISTINCT FROM r.email   THEN v_changes := v_changes || jsonb_build_object('email',   jsonb_build_object('before', wacrm.audit_mask_value('email', r.o_email),     'after', wacrm.audit_mask_value('email', r.email))); END IF;
      IF r.o_cpf     IS DISTINCT FROM r.cpf     THEN v_changes := v_changes || jsonb_build_object('cpf',     jsonb_build_object('before', wacrm.audit_mask_value('cpf', r.o_cpf),         'after', wacrm.audit_mask_value('cpf', r.cpf))); END IF;
      IF r.o_company IS DISTINCT FROM r.company THEN v_changes := v_changes || jsonb_build_object('company', jsonb_build_object('before', wacrm.audit_mask_value('company', r.o_company), 'after', wacrm.audit_mask_value('company', r.company))); END IF;
      v_label := coalesce(nullif(wacrm.audit_mask_value('name', r.name), ''), wacrm.audit_mask_value('phone', r.phone), 'Contato');
      PERFORM wacrm.audit_write(r.account_id, 'updated', 'contact', r.id, v_label, 'contact.updated',
        format('Contato %s alterado (%s)', v_label, (SELECT string_agg(k, ', ' ORDER BY k) FROM jsonb_object_keys(v_changes) k)), v_changes);
    END LOOP;
  ELSE
    FOR r IN
      SELECT n.account_id, count(*) AS n,
             count(*) FILTER (WHERE o.name    IS DISTINCT FROM n.name)    AS c_name,
             count(*) FILTER (WHERE o.phone   IS DISTINCT FROM n.phone)   AS c_phone,
             count(*) FILTER (WHERE o.email   IS DISTINCT FROM n.email)   AS c_email,
             count(*) FILTER (WHERE o.cpf     IS DISTINCT FROM n.cpf)     AS c_cpf,
             count(*) FILTER (WHERE o.company IS DISTINCT FROM n.company) AS c_company,
             (array_agg(n.id))[1:5] AS sample
        FROM new_rows n JOIN old_rows o ON o.id = n.id
       WHERE n.account_id IS NOT NULL
         AND (o.name, o.phone, o.email, o.cpf, o.company) IS DISTINCT FROM (n.name, n.phone, n.email, n.cpf, n.company)
       GROUP BY n.account_id
    LOOP
      PERFORM wacrm.audit_write(r.account_id, 'updated', 'contact', gen_random_uuid(), 'Lote de contatos', 'contact.bulk_updated',
        format('%s contatos alterados em lote', r.n), NULL,
        jsonb_build_object('count', r.n, 'sample_ids', to_jsonb(r.sample),
          'fields_changed', jsonb_strip_nulls(jsonb_build_object(
            'name', nullif(r.c_name, 0), 'phone', nullif(r.c_phone, 0), 'email', nullif(r.c_email, 0),
            'cpf', nullif(r.c_cpf, 0), 'company', nullif(r.c_company, 0)))));
    END LOOP;
  END IF;
  RETURN NULL;
EXCEPTION WHEN others THEN
  RAISE WARNING 'audit_contacts_update_stmt falhou: %', SQLERRM;
  RETURN NULL;
END;
$$;

-- ---- contatos: DELETE (sem telefone/e-mail em claro no metadata) ------------------------------------------------------
CREATE OR REPLACE FUNCTION wacrm.audit_contacts_delete_stmt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
DECLARE
  r record;
  v_n integer;
  v_label text;
BEGIN
  SELECT count(*) INTO v_n FROM old_rows;
  IF v_n = 0 THEN RETURN NULL; END IF;
  IF v_n <= wacrm.audit_bulk_threshold() THEN
    FOR r IN SELECT id, account_id, name, phone, email FROM old_rows LOOP
      v_label := coalesce(nullif(wacrm.audit_mask_value('name', r.name), ''), wacrm.audit_mask_value('phone', r.phone), 'Contato');
      PERFORM wacrm.audit_write(r.account_id, 'deleted', 'contact', r.id, v_label, 'contact.deleted', format('Contato %s excluído', v_label), NULL,
        jsonb_build_object('phone', wacrm.audit_mask_value('phone', r.phone), 'email', wacrm.audit_mask_value('email', r.email)));
    END LOOP;
  ELSE
    FOR r IN SELECT account_id, count(*) AS n, (array_agg(id))[1:5] AS sample FROM old_rows WHERE account_id IS NOT NULL GROUP BY account_id LOOP
      PERFORM wacrm.audit_write(r.account_id, 'deleted', 'contact', gen_random_uuid(), 'Lote de contatos', 'contact.bulk_deleted',
        format('%s contatos excluídos em lote', r.n), NULL, jsonb_build_object('count', r.n, 'sample_ids', to_jsonb(r.sample)));
    END LOOP;
  END IF;
  RETURN NULL;
EXCEPTION WHEN others THEN
  RAISE WARNING 'audit_contacts_delete_stmt falhou: %', SQLERRM;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_contacts ON wacrm.contacts;  -- a por-linha da 131 (valor em claro)
DROP TRIGGER IF EXISTS trg_audit_contacts_ins ON wacrm.contacts;
CREATE TRIGGER trg_audit_contacts_ins AFTER INSERT ON wacrm.contacts
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION wacrm.audit_contacts_insert_stmt();
DROP TRIGGER IF EXISTS trg_audit_contacts_upd ON wacrm.contacts;
CREATE TRIGGER trg_audit_contacts_upd AFTER UPDATE ON wacrm.contacts
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION wacrm.audit_contacts_update_stmt();
DROP TRIGGER IF EXISTS trg_audit_contacts_del ON wacrm.contacts;
CREATE TRIGGER trg_audit_contacts_del AFTER DELETE ON wacrm.contacts
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION wacrm.audit_contacts_delete_stmt();

-- ---- etiquetas do contato ---------------------------------------------------------------------------------------------
-- Contato apagado em cascata: o JOIN com contacts não acha a linha e o evento de exclusão do contato já basta (como na 131).
CREATE OR REPLACE FUNCTION wacrm.audit_contact_tags_insert_stmt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
DECLARE
  r record;
  v_n integer;
  v_label text;
BEGIN
  SELECT count(*) INTO v_n FROM new_rows;
  IF v_n = 0 THEN RETURN NULL; END IF;
  IF v_n <= wacrm.audit_bulk_threshold() THEN
    FOR r IN
      SELECT c.id AS contact_id, c.account_id, c.name, c.phone, t.id AS tag_id, t.name AS tag
        FROM new_rows x JOIN wacrm.contacts c ON c.id = x.contact_id LEFT JOIN wacrm.tags t ON t.id = x.tag_id
    LOOP
      v_label := coalesce(nullif(wacrm.audit_mask_value('name', r.name), ''), wacrm.audit_mask_value('phone', r.phone), 'Contato');
      PERFORM wacrm.audit_write(r.account_id, 'updated', 'contact', r.contact_id, v_label, 'contact.tag_added',
        format('Etiqueta %s adicionada em %s', coalesce(r.tag, '?'), v_label), NULL, jsonb_build_object('tag_id', r.tag_id, 'tag', r.tag));
    END LOOP;
  ELSE
    FOR r IN
      SELECT c.account_id, count(*) AS n, count(DISTINCT x.contact_id) AS contacts, (array_agg(DISTINCT x.tag_id))[1:5] AS tags
        FROM new_rows x JOIN wacrm.contacts c ON c.id = x.contact_id WHERE c.account_id IS NOT NULL GROUP BY c.account_id
    LOOP
      PERFORM wacrm.audit_write(r.account_id, 'updated', 'contact', gen_random_uuid(), 'Lote de contatos', 'contact.bulk_tag_added',
        format('%s etiquetas adicionadas em %s contatos', r.n, r.contacts), NULL, jsonb_build_object('count', r.n, 'contacts', r.contacts, 'tag_ids', to_jsonb(r.tags)));
    END LOOP;
  END IF;
  RETURN NULL;
EXCEPTION WHEN others THEN
  RAISE WARNING 'audit_contact_tags_insert_stmt falhou: %', SQLERRM;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION wacrm.audit_contact_tags_delete_stmt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
DECLARE
  r record;
  v_n integer;
  v_label text;
BEGIN
  SELECT count(*) INTO v_n FROM old_rows;
  IF v_n = 0 THEN RETURN NULL; END IF;
  IF v_n <= wacrm.audit_bulk_threshold() THEN
    FOR r IN
      SELECT c.id AS contact_id, c.account_id, c.name, c.phone, t.id AS tag_id, t.name AS tag
        FROM old_rows x JOIN wacrm.contacts c ON c.id = x.contact_id LEFT JOIN wacrm.tags t ON t.id = x.tag_id
    LOOP
      v_label := coalesce(nullif(wacrm.audit_mask_value('name', r.name), ''), wacrm.audit_mask_value('phone', r.phone), 'Contato');
      PERFORM wacrm.audit_write(r.account_id, 'updated', 'contact', r.contact_id, v_label, 'contact.tag_removed',
        format('Etiqueta %s removida em %s', coalesce(r.tag, '?'), v_label), NULL, jsonb_build_object('tag_id', r.tag_id, 'tag', r.tag));
    END LOOP;
  ELSE
    FOR r IN
      SELECT c.account_id, count(*) AS n, count(DISTINCT x.contact_id) AS contacts, (array_agg(DISTINCT x.tag_id))[1:5] AS tags
        FROM old_rows x JOIN wacrm.contacts c ON c.id = x.contact_id WHERE c.account_id IS NOT NULL GROUP BY c.account_id
    LOOP
      PERFORM wacrm.audit_write(r.account_id, 'updated', 'contact', gen_random_uuid(), 'Lote de contatos', 'contact.bulk_tag_removed',
        format('%s etiquetas removidas de %s contatos', r.n, r.contacts), NULL, jsonb_build_object('count', r.n, 'contacts', r.contacts, 'tag_ids', to_jsonb(r.tags)));
    END LOOP;
  END IF;
  RETURN NULL;
EXCEPTION WHEN others THEN
  RAISE WARNING 'audit_contact_tags_delete_stmt falhou: %', SQLERRM;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_contact_tags ON wacrm.contact_tags;  -- a por-linha da 131
DROP TRIGGER IF EXISTS trg_audit_contact_tags_ins ON wacrm.contact_tags;
CREATE TRIGGER trg_audit_contact_tags_ins AFTER INSERT ON wacrm.contact_tags
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION wacrm.audit_contact_tags_insert_stmt();
DROP TRIGGER IF EXISTS trg_audit_contact_tags_del ON wacrm.contact_tags;
CREATE TRIGGER trg_audit_contact_tags_del AFTER DELETE ON wacrm.contact_tags
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION wacrm.audit_contact_tags_delete_stmt();

-- ---- blacklist / opt-out ----------------------------------------------------------------------------------------------
-- Colunas lidas: id, account_id, telefone, motivo, bloqueado_por. mensagem_detectada (texto do cliente) NUNCA entra na auditoria.
-- Linha sem account_id (bloqueio global) não gera evento (audit_logs.account_id é NOT NULL).
CREATE OR REPLACE FUNCTION wacrm.audit_blacklist_insert_stmt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
DECLARE
  r record;
  v_n integer;
  v_phone text;
BEGIN
  SELECT count(*) INTO v_n FROM new_rows;
  IF v_n = 0 THEN RETURN NULL; END IF;
  IF v_n <= wacrm.audit_bulk_threshold() THEN
    FOR r IN SELECT to_jsonb(b) AS j FROM new_rows b LOOP
      v_phone := wacrm.audit_mask_value('phone', r.j ->> 'telefone');
      PERFORM wacrm.audit_write((r.j ->> 'account_id')::uuid, 'created', 'blacklist', wacrm.audit_resource_uuid(r.j ->> 'id'), v_phone,
        CASE WHEN r.j ->> 'motivo' = 'opt_out' THEN 'contact.opted_out' ELSE 'blacklist.added' END,
        format('Número %s adicionado à blacklist (%s)', v_phone, coalesce(r.j ->> 'motivo', 'sem motivo')), NULL,
        jsonb_build_object('motivo', r.j ->> 'motivo', 'bloqueado_por', r.j ->> 'bloqueado_por'));
    END LOOP;
  ELSE
    FOR r IN
      SELECT (to_jsonb(b) ->> 'account_id')::uuid AS account_id, count(*) AS n
        FROM new_rows b WHERE to_jsonb(b) ->> 'account_id' IS NOT NULL GROUP BY 1
    LOOP
      PERFORM wacrm.audit_write(r.account_id, 'created', 'blacklist', gen_random_uuid(), 'Lote de bloqueios', 'blacklist.bulk_added',
        format('%s números adicionados à blacklist em lote', r.n), NULL, jsonb_build_object('count', r.n));
    END LOOP;
  END IF;
  RETURN NULL;
EXCEPTION WHEN others THEN
  RAISE WARNING 'audit_blacklist_insert_stmt falhou: %', SQLERRM;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION wacrm.audit_blacklist_update_stmt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
DECLARE
  r record;
  v_n integer;
  v_phone text;
  v_changes jsonb;
BEGIN
  -- Só motivo/telefone/quem bloqueou importam (upsert do opt-out reescreve a linha com os mesmos valores: sem evento).
  SELECT count(*) INTO v_n FROM new_rows n JOIN old_rows o ON o.id = n.id
   WHERE (to_jsonb(o) ->> 'telefone', to_jsonb(o) ->> 'motivo', to_jsonb(o) ->> 'bloqueado_por')
         IS DISTINCT FROM (to_jsonb(n) ->> 'telefone', to_jsonb(n) ->> 'motivo', to_jsonb(n) ->> 'bloqueado_por');
  IF v_n = 0 THEN RETURN NULL; END IF;
  IF v_n <= wacrm.audit_bulk_threshold() THEN
    FOR r IN
      SELECT to_jsonb(n) AS nj, to_jsonb(o) AS oj FROM new_rows n JOIN old_rows o ON o.id = n.id
       WHERE (to_jsonb(o) ->> 'telefone', to_jsonb(o) ->> 'motivo', to_jsonb(o) ->> 'bloqueado_por')
             IS DISTINCT FROM (to_jsonb(n) ->> 'telefone', to_jsonb(n) ->> 'motivo', to_jsonb(n) ->> 'bloqueado_por')
    LOOP
      v_changes := '{}'::jsonb;
      IF r.oj ->> 'telefone' IS DISTINCT FROM r.nj ->> 'telefone' THEN
        v_changes := v_changes || jsonb_build_object('telefone', jsonb_build_object('before', wacrm.audit_mask_value('phone', r.oj ->> 'telefone'), 'after', wacrm.audit_mask_value('phone', r.nj ->> 'telefone')));
      END IF;
      IF r.oj ->> 'motivo' IS DISTINCT FROM r.nj ->> 'motivo' THEN
        v_changes := v_changes || jsonb_build_object('motivo', jsonb_build_object('before', r.oj ->> 'motivo', 'after', r.nj ->> 'motivo'));
      END IF;
      IF r.oj ->> 'bloqueado_por' IS DISTINCT FROM r.nj ->> 'bloqueado_por' THEN
        v_changes := v_changes || jsonb_build_object('bloqueado_por', jsonb_build_object('before', r.oj ->> 'bloqueado_por', 'after', r.nj ->> 'bloqueado_por'));
      END IF;
      v_phone := wacrm.audit_mask_value('phone', r.nj ->> 'telefone');
      PERFORM wacrm.audit_write((r.nj ->> 'account_id')::uuid, 'updated', 'blacklist', wacrm.audit_resource_uuid(r.nj ->> 'id'), v_phone, 'blacklist.updated',
        format('Bloqueio de %s alterado (%s)', v_phone, (SELECT string_agg(k, ', ' ORDER BY k) FROM jsonb_object_keys(v_changes) k)), v_changes);
    END LOOP;
  ELSE
    FOR r IN
      SELECT (to_jsonb(n) ->> 'account_id')::uuid AS account_id, count(*) AS n
        FROM new_rows n JOIN old_rows o ON o.id = n.id
       WHERE to_jsonb(n) ->> 'account_id' IS NOT NULL
         AND (to_jsonb(o) ->> 'telefone', to_jsonb(o) ->> 'motivo', to_jsonb(o) ->> 'bloqueado_por')
             IS DISTINCT FROM (to_jsonb(n) ->> 'telefone', to_jsonb(n) ->> 'motivo', to_jsonb(n) ->> 'bloqueado_por')
       GROUP BY 1
    LOOP
      PERFORM wacrm.audit_write(r.account_id, 'updated', 'blacklist', gen_random_uuid(), 'Lote de bloqueios', 'blacklist.bulk_updated',
        format('%s bloqueios alterados em lote', r.n), NULL, jsonb_build_object('count', r.n));
    END LOOP;
  END IF;
  RETURN NULL;
EXCEPTION WHEN others THEN
  RAISE WARNING 'audit_blacklist_update_stmt falhou: %', SQLERRM;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION wacrm.audit_blacklist_delete_stmt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
DECLARE
  r record;
  v_n integer;
  v_phone text;
BEGIN
  SELECT count(*) INTO v_n FROM old_rows;
  IF v_n = 0 THEN RETURN NULL; END IF;
  IF v_n <= wacrm.audit_bulk_threshold() THEN
    FOR r IN SELECT to_jsonb(b) AS j FROM old_rows b LOOP
      v_phone := wacrm.audit_mask_value('phone', r.j ->> 'telefone');
      PERFORM wacrm.audit_write((r.j ->> 'account_id')::uuid, 'deleted', 'blacklist', wacrm.audit_resource_uuid(r.j ->> 'id'), v_phone,
        'blacklist.removed', format('Número %s removido da blacklist', v_phone), NULL,
        jsonb_build_object('motivo', r.j ->> 'motivo', 'bloqueado_por', r.j ->> 'bloqueado_por'));
    END LOOP;
  ELSE
    FOR r IN
      SELECT (to_jsonb(b) ->> 'account_id')::uuid AS account_id, count(*) AS n
        FROM old_rows b WHERE to_jsonb(b) ->> 'account_id' IS NOT NULL GROUP BY 1
    LOOP
      PERFORM wacrm.audit_write(r.account_id, 'deleted', 'blacklist', gen_random_uuid(), 'Lote de bloqueios', 'blacklist.bulk_removed',
        format('%s números removidos da blacklist em lote', r.n), NULL, jsonb_build_object('count', r.n));
    END LOOP;
  END IF;
  RETURN NULL;
EXCEPTION WHEN others THEN
  RAISE WARNING 'audit_blacklist_delete_stmt falhou: %', SQLERRM;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.audit_contacts_insert_stmt(), wacrm.audit_contacts_update_stmt(), wacrm.audit_contacts_delete_stmt(),
  wacrm.audit_contact_tags_insert_stmt(), wacrm.audit_contact_tags_delete_stmt(), wacrm.audit_blacklist_insert_stmt(),
  wacrm.audit_blacklist_update_stmt(), wacrm.audit_blacklist_delete_stmt() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF to_regclass('wacrm.blacklist') IS NULL THEN
    RAISE NOTICE '222: wacrm.blacklist não existe, triggers de blacklist ignorados';
    RETURN;
  END IF;
  EXECUTE 'DROP TRIGGER IF EXISTS trg_audit_blacklist_ins ON wacrm.blacklist';
  EXECUTE 'CREATE TRIGGER trg_audit_blacklist_ins AFTER INSERT ON wacrm.blacklist REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION wacrm.audit_blacklist_insert_stmt()';
  EXECUTE 'DROP TRIGGER IF EXISTS trg_audit_blacklist_upd ON wacrm.blacklist';
  EXECUTE 'CREATE TRIGGER trg_audit_blacklist_upd AFTER UPDATE ON wacrm.blacklist REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION wacrm.audit_blacklist_update_stmt()';
  EXECUTE 'DROP TRIGGER IF EXISTS trg_audit_blacklist_del ON wacrm.blacklist';
  EXECUTE 'CREATE TRIGGER trg_audit_blacklist_del AFTER DELETE ON wacrm.blacklist REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION wacrm.audit_blacklist_delete_stmt()';
END $$;

-- Registro (202): tolera banco sem a 202 ainda; idempotente.
DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('222_audit_contacts') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';

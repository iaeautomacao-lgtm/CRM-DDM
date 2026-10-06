-- Aplicar SOMENTE depois do deploy do PR #43 e da execução de:
-- node scripts/encrypt-plaintext-app-secrets.mjs --apply
-- O POST precisa gravar credenciais pelo service_role antes desta restrição.
BEGIN;

-- Um GRANT na tabela prevalece sobre permissões por coluna.
REVOKE UPDATE ON wacrm.whatsapp_config FROM authenticated;
-- Não há INSERT/upsert direto no navegador; criação fica no servidor.
REVOKE INSERT ON wacrm.whatsapp_config FROM authenticated;

-- Limpar também eventuais grants por coluna, inclusive de execuções anteriores.
DO $$
DECLARE
  v_columns text;
BEGIN
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum)
    INTO v_columns
    FROM pg_attribute
   WHERE attrelid = 'wacrm.whatsapp_config'::regclass
     AND attnum > 0
     AND NOT attisdropped;

  EXECUTE format(
    'REVOKE INSERT (%s), UPDATE (%s) ON wacrm.whatsapp_config FROM authenticated',
    v_columns, v_columns
  );
END;
$$;

-- A UI usa /api/whatsapp/config, sem escritas diretas nesta tabela.
-- Preservar o PATCH não secreto, que ainda usa o cliente authenticated.
-- app_secret, verify_token, access_token e waha_api_key ficam sem INSERT/UPDATE.
GRANT UPDATE (flow_id, receptivo, habilitado, team_id, client_id)
  ON wacrm.whatsapp_config TO authenticated;

-- Manter todas as permissões do servidor; RLS, SELECT e DELETE não mudam.
GRANT ALL ON wacrm.whatsapp_config TO service_role;

COMMIT;
NOTIFY pgrst, 'reload schema';

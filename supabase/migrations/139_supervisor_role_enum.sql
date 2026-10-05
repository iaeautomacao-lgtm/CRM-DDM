-- Migration 139: novo papel "supervisor" no enum de papéis (PRD-04).
-- APLICAR MANUALMENTE, SOZINHA, no Supabase SQL Editor — e só DEPOIS a 140.
--
-- Por que separada: um valor novo de enum só pode ser usado depois do
-- COMMIT que o criou. A 140 (regras de acesso) compara com 'supervisor'
-- e falharia ("unsafe use of new value") se rodasse na mesma transação.
--
-- O enum foi criado na 017 sem schema explícito; aqui ele é localizado
-- pelo nome para funcionar em public ou wacrm. Conferir o schema live
-- antes (CLAUDE.md).

DO $$
DECLARE
  v_schema text;
BEGIN
  SELECT n.nspname INTO v_schema
  FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE t.typname = 'account_role_enum'
  LIMIT 1;
  IF v_schema IS NULL THEN
    RAISE EXCEPTION 'account_role_enum não encontrado';
  END IF;
  EXECUTE format(
    'ALTER TYPE %I.account_role_enum ADD VALUE IF NOT EXISTS %L BEFORE %L',
    v_schema, 'supervisor', 'agent'
  );
END;
$$;

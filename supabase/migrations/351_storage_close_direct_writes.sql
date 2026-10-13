-- ============================================================
-- 351_storage_close_direct_writes.sql   (plano de segurança 13/10 — Ladrilho, upload: fechar a escrita direta)
--
-- *** RODAR DEPOIS DO DEPLOY DO FRONT (branch sec/upload-url-assinada + esta). ***
-- O front ANTIGO sobe o anexo direto no Storage com a sessão do usuário (supabase.storage.upload) e apaga rascunho do mesmo jeito.
-- Esta migration remove essas policies de escrita: com o front antigo ainda no ar, todo anexo (Inbox, chat interno, templates,
-- campanhas, fluxos) deixa de subir. Com o front novo, o navegador não escreve mais no bucket: o upload sai por URL assinada emitida
-- pelo servidor (POST /api/media/upload-url) e é revalidado em POST /api/media/confirm; o descarte de rascunho passa por
-- POST /api/media/delete. O servidor usa a chave de serviço, que ignora RLS: nada disso depende destas policies.
--
-- O que muda (storage.objects, buckets chat-media e flow-media):
--   REMOVE  as policies de INSERT, UPDATE e DELETE do navegador (016/020/023): "Members can upload|update|delete chat media" e
--           "Members can upload|update|delete flow media" (e as de nome antigo "Users can ... their own flow media").
--   REMOVE  qualquer outra policy de INSERT/UPDATE/DELETE cujo texto cite chat-media ou flow-media (nome diferente em produção).
--   MANTÉM  as de LEITURA (SELECT): /api/chat-media assina a URL com a sessão do usuário (121) e flow-media é público (016).
--   NÃO MEXE em avatars nem nos demais buckets. Policy que cita outro bucket junto, ou do tipo ALL (cobre a leitura), NÃO é
--           removida: gera WARNING para revisão manual.
--
-- PRÉ-CHECK:  SELECT policyname, cmd FROM pg_policies WHERE schemaname='storage' AND tablename='objects'
--              AND (qual ~ '(chat-media|flow-media)' OR with_check ~ '(chat-media|flow-media)') ORDER BY cmd, policyname;
--              (confira o que existe de fato em produção; as migrations podem não refletir o live)
-- VERIFICAÇÃO: a mesma consulta: devem sobrar SÓ policies com cmd = 'SELECT' (e as que geraram WARNING).
--              Teste de fumaça: com o front novo, enviar um anexo no Inbox e no chat interno; com o token do navegador,
--              supabase.storage.from('chat-media').upload(...) deve devolver erro de RLS.
-- ORDEM: depois do deploy do front. Independente das demais migrations do plano.
-- ROLLBACK: recriar as policies das migrations 020 (flow-media) e 023 (chat-media): "Members can upload|update|delete ...".
-- ============================================================

BEGIN;

-- 1) Pelos nomes conhecidos (016/020/023).
DROP POLICY IF EXISTS "Members can upload chat media" ON storage.objects;
DROP POLICY IF EXISTS "Members can update chat media" ON storage.objects;
DROP POLICY IF EXISTS "Members can delete chat media" ON storage.objects;
DROP POLICY IF EXISTS "Members can upload flow media" ON storage.objects;
DROP POLICY IF EXISTS "Members can update flow media" ON storage.objects;
DROP POLICY IF EXISTS "Members can delete flow media" ON storage.objects;
DROP POLICY IF EXISTS "Users can upload their own flow media" ON storage.objects;
DROP POLICY IF EXISTS "Users can update their own flow media" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete their own flow media" ON storage.objects;

-- 2) Qualquer outra de escrita que cite os dois buckets (produção pode ter nome diferente das migrations).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT policyname, cmd,
           (coalesce(qual, '') || ' ' || coalesce(with_check, '')) AS body
      FROM pg_policies
     WHERE schemaname = 'storage' AND tablename = 'objects'
       AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ '(chat-media|flow-media)'
       AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  LOOP
    IF r.cmd = 'ALL' THEN
      RAISE WARNING '351: policy ALL "%" cobre chat-media/flow-media e também a leitura; revisar à mão (não removida)', r.policyname;
    ELSIF r.body ~ '(avatars|relatorio-exports)' THEN
      RAISE WARNING '351: policy "%" (%) cita chat-media/flow-media e outro bucket; revisar à mão (não removida)', r.policyname, r.cmd;
    ELSE
      EXECUTE format('DROP POLICY %I ON storage.objects', r.policyname);
      RAISE NOTICE '351: policy "%" (%) removida', r.policyname, r.cmd;
    END IF;
  END LOOP;
END $$;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('351_storage_close_direct_writes') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;

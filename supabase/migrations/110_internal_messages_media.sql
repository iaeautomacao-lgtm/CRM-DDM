-- Migration 110: mídia em wacrm.internal_messages (migration 109).
-- media_url: URL pública do arquivo no Storage (bucket chat-media,
-- reaproveitado do inbox — mesma convenção de path account-scoped,
-- mesma RLS genérica por conta, sem depender de nada WhatsApp-específico).
-- media_type: MIME type (ex: image/jpeg, audio/webm, application/pdf).
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy.

ALTER TABLE wacrm.internal_messages
  ADD COLUMN media_url TEXT,
  ADD COLUMN media_type TEXT;

-- Mensagem pode ter content vazio se tiver media_url (e vice-versa), mas
-- não as duas coisas vazias ao mesmo tempo. Não pedido explicitamente,
-- mas content já era NOT NULL — sem esse guard uma linha totalmente vazia
-- (content='' AND media_url NULL) passaria pelo schema silenciosamente.
ALTER TABLE wacrm.internal_messages
  ADD CONSTRAINT internal_messages_content_or_media
  CHECK (content <> '' OR media_url IS NOT NULL);

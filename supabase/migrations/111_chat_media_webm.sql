-- Migration 111: adiciona audio/webm ao allowed_mime_types do bucket
-- chat-media (023_chat_media.sql). Chrome/Edge/Opera só conseguem
-- gravar áudio via MediaRecorder nesse formato — não existe
-- alternativa nativa nesses navegadores sem reintroduzir uma lib de
-- encoding client-side (opus-recorder, deliberadamente evitado no
-- chat interno). audio/ogg e audio/mp4 continuam preferidos quando o
-- navegador suporta (Firefox e Safari, respectivamente); webm fica
-- como o fallback que efetivamente cobre a maioria dos usuários.
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy.

UPDATE storage.buckets
SET allowed_mime_types = array_append(allowed_mime_types, 'audio/webm')
WHERE id = 'chat-media'
  AND NOT ('audio/webm' = ANY(allowed_mime_types));

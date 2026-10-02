BEGIN;
UPDATE storage.buckets SET public = false WHERE id = 'chat-media';
DROP POLICY IF EXISTS "Chat media is publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Account members can read chat media" ON storage.objects;
CREATE POLICY "Account members can read chat media" ON storage.objects
FOR SELECT TO authenticated USING (
  bucket_id = 'chat-media' AND EXISTS (
    SELECT 1 FROM wacrm.profiles p WHERE p.user_id = auth.uid()
    AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
  )
);
-- Preserve objects. Browser references are normalized by the application;
-- providers receive freshly authorized short-lived URLs at send time.
COMMIT;

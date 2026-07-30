-- ============================================================
-- 044_fix_mojibake_outcome_tags
--
-- Investigation: the outcome tag seeded with codigo_tabulacao = 16
-- ("Sem Tabulacao", with a cedilla-c and a tilde-a) came back from the
-- DB mojibake'd after migration 041's seed ran.
--
-- 1. supabase/migrations/041_conversation_outcome_tags.sql on disk was
--    (and is) correctly UTF-8 encoded - verified with `file -i`
--    (charset=utf-8) and by hex-dumping the accented lines directly.
--    The file was never the problem.
--
-- 2. The corruption is the classic "UTF-8 bytes decoded as
--    Windows-1252" mojibake, introduced by the tool migration 041 was
--    pasted into and run through (a browser-based SQL editor that
--    re-decodes accented paste content as Windows-1252 before it
--    reaches Postgres) - reproduced byte-for-byte outside the DB.
--
-- 3. The first attempt at this fix (this same file, first revision)
--    used accented literals in its own WHERE clause as a safeguard.
--    Those literals got mangled the same way when pasted into the
--    same SQL editor, so the WHERE never matched anything and the
--    fix silently did nothing.
--
-- This revision avoids that failure mode entirely: every string in
-- this file is plain ASCII. The three target names are written with
-- Postgres's U&'...' Unicode escape string syntax (\XXXX = codepoint)
-- instead of literal accented characters, so there is nothing in this
-- file for a lossy paste to corrupt. Targeting is also done by
-- codigo_tabulacao (16, 935, 934) instead of comparing against the
-- (possibly still-corrupted) stored name - codigo_tabulacao is a
-- plain integer, immune to this class of bug, and uniquely identifies
-- each of the three affected rows in every account.
--
-- The three names, spelled out without their accents for reference
-- (this comment is not used in the SQL below, which uses the escapes
-- instead):
--   codigo_tabulacao = 16  -> "Sem Tabulacao" (c-cedilla, a-tilde)
--   codigo_tabulacao = 935 -> "NEGOCIACAO - FORA DO PRAZO" (C-cedilla, A-tilde)
--   codigo_tabulacao = 934 -> "SEM PREVISAO PARA PAGAMENTO" (A-tilde)
-- ============================================================

UPDATE wacrm.tags
SET name = U&'Sem Tabula\00E7\00E3o'
WHERE kind = 'outcome' AND codigo_tabulacao = 16;

UPDATE wacrm.tags
SET name = U&'NEGOCIA\00C7\00C3O - FORA DO PRAZO'
WHERE kind = 'outcome' AND codigo_tabulacao = 935;

UPDATE wacrm.tags
SET name = U&'SEM PREVIS\00C3O PARA PAGAMENTO'
WHERE kind = 'outcome' AND codigo_tabulacao = 934;

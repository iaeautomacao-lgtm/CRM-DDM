-- ============================================================
-- 044_fix_mojibake_outcome_tags
--
-- Investigation (per report): "Sem Tabulação" came back from the DB
-- as "Sem TabulaÃ§Ã£o" after migration 041's seed ran.
--
-- 1. supabase/migrations/041_conversation_outcome_tags.sql on disk is
--    correctly UTF-8 encoded — verified with `file -i` (charset=utf-8)
--    and by hex-dumping the accented lines directly: "ção" is stored
--    as bytes c3 a7 c3 a3 6f, the correct UTF-8 sequence for ç, ã, o.
--    The file is not the problem.
--
-- 2. The corruption is the classic "UTF-8 bytes decoded as
--    Windows-1252" mojibake, introduced wherever migration 041 was
--    actually executed (e.g. pasted into a browser-based SQL editor
--    that re-decoded the UTF-8 text as Windows-1252 before it reached
--    Postgres) — not a defect in the migration file. Reproduced
--    exactly: taking the correct UTF-8 bytes for "Sem Tabulação" and
--    decoding them as Windows-1252 yields "Sem TabulaÃ§Ã£o" byte for
--    byte, matching the report.
--
-- Of the 77 seeded tags, only 3 contain non-ASCII characters and are
-- therefore the only ones this could have corrupted:
--   "Sem Tabulação", "NEGOCIAÇÃO - FORA DO PRAZO",
--   "SEM PREVISÃO PARA PAGAMENTO"
-- (The other 74 names are plain ASCII — as originally seeded, e.g.
-- "ALEGA NAO CONFIRMA DADOS" — so a Windows-1252/UTF-8 mismatch
-- cannot have altered them; ASCII bytes round-trip identically
-- through every one of these encodings.)
--
-- Fix: for every wacrm.tags row with kind = 'outcome', reverse the
-- Windows-1252-as-UTF-8 misdecode (re-encode the stored text as
-- WIN1252 to recover the original UTF-8 bytes, then decode those as
-- UTF-8) and only apply the result when it lands on one of the 3
-- known-correct names above AND actually differs from what's stored.
-- That guard makes this self-verifying (never "fixes" a name into
-- something unexpected) and idempotent (a no-op on already-correct
-- rows or on rows unaffected by this bug), across every account.
-- ============================================================

UPDATE wacrm.tags AS t
SET name = fixed.name
FROM (
  SELECT id, convert_from(convert_to(name, 'WIN1252'), 'UTF8') AS name
  FROM wacrm.tags
  WHERE kind = 'outcome'
) AS fixed
WHERE t.id = fixed.id
  AND t.name <> fixed.name
  AND fixed.name IN (
    'Sem Tabulação',
    'NEGOCIAÇÃO - FORA DO PRAZO',
    'SEM PREVISÃO PARA PAGAMENTO'
  );

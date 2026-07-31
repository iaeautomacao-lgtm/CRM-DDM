-- 047_default_currency_brl.sql
-- Switch the app-wide default deal currency from USD to BRL. This is
-- a Brazil-only CRM — no FX conversion happens here, numeric values
-- are unchanged; only the currency label/default was wrong.

ALTER TABLE wacrm.accounts ALTER COLUMN default_currency SET DEFAULT 'BRL';
UPDATE wacrm.accounts SET default_currency = 'BRL' WHERE default_currency = 'USD';

ALTER TABLE wacrm.deals ALTER COLUMN currency SET DEFAULT 'BRL';
UPDATE wacrm.deals SET currency = 'BRL' WHERE currency = 'USD' OR currency IS NULL;

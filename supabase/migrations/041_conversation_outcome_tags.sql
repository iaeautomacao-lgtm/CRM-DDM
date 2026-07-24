-- ============================================================
-- 041_conversation_outcome_tags
--
-- Adds a "tag de encerramento" (tabulação) to conversations: when a
-- conversation is closed, the agent picks a tag describing the
-- outcome (e.g. "Acordo Realizado", "Sem Tabulação").
--
-- Reuses the existing wacrm.tags dictionary rather than a separate
-- table — contact tags are a persistent profile attribute (many per
-- contact), while an outcome tag is a single classification for one
-- closure event, so conversations gets a plain FK column instead of
-- a join table.
--
-- Also adds tags.codigo_olos for the future Olos integration (each
-- "tabulação" tag maps 1:1 to an Olos code).
--
-- tags is account-scoped (account_id NOT NULL, migration 017) with no
-- global/shared rows supported by the current RLS model, so the seed
-- below follows that pattern: one copy of each tabulação tag is
-- inserted per existing account, keyed off accounts.owner_user_id to
-- satisfy tags.user_id NOT NULL. New accounts created after this
-- migration will not get these seeded automatically.
--
-- Idempotent — safe to re-run (column adds are IF NOT EXISTS; the
-- seed only inserts a tag for an account if that account doesn't
-- already have a tag with that name).
-- ============================================================

ALTER TABLE wacrm.tags
  ADD COLUMN IF NOT EXISTS codigo_olos INTEGER;

ALTER TABLE wacrm.conversations
  ADD COLUMN IF NOT EXISTS outcome_tag_id UUID REFERENCES wacrm.tags(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_outcome_tag ON wacrm.conversations(outcome_tag_id);

-- ============================================================
-- Seed: default "tabulação" tags, per existing account
-- ============================================================
DO $$
DECLARE
  v_account RECORD;
  v_seed RECORD;
BEGIN
  FOR v_account IN SELECT id, owner_user_id FROM wacrm.accounts LOOP
    FOR v_seed IN SELECT * FROM (VALUES
      ('2 VIA BOLETO', 353),
      ('Acordo Realizado', 142),
      ('Adimplente', 335),
      ('Afirma abandono-trancamento', 224),
      ('Afirma bolsa integral', 143),
      ('Afirma bolsa parcial', 144),
      ('Afirma pagamento', 145),
      ('AGENDAMENTO', 376),
      ('AGUARDA_MELHOR_PROPOSTA', 248),
      ('ALEGA ACAO JUDICIAL', 221),
      ('Alega Bolsa', 344),
      ('Alega conclusao de curso', 147),
      ('ALEGA FINANCIAMENTO', 374),
      ('ALEGA NAO CONFIRMA DADOS', 207),
      ('Alega nao ter cursado', 343),
      ('ALEGA NAO TER NEGOCIADO', 369),
      ('Alega nao ter se matriculado', 148),
      ('ALEGA PAGAMENTO', 107),
      ('ALEGA PRAVALER', 259),
      ('ALEGA PROUNI', 265),
      ('Alega Trancamento', 342),
      ('ALEGA_BOLSA', 253),
      ('ALEGA_FIES', 255),
      ('ALEGA_NAO_MATRICULOU', 270),
      ('ALUNO_SOLICITA_RETORNO', 279),
      ('BlockList', 138),
      ('Bloqueio', 331),
      ('BOLETO INDISPONIVEL PARA PAGAMENTO', 370),
      ('BOLETO REENVIADO', 371),
      ('CAMPANHA FATURAO', 223),
      ('CAMPANHA REGRESSO', 222),
      ('CANCELOU-TRANCOU', 283),
      ('CLIENTE DESCONHECIDO', 208),
      ('CONDICOES OFERTADAS NAO ATENDEM', 375),
      ('CONSTA PAGAMENTO', 940),
      ('CONTESTA - Contesta Debitos - Nao Concorda com Valor', 178),
      ('CONTRA_PROPOSTA', 298),
      ('Debito consta em outra assessoria', 229),
      ('DESCONHECE DIVIDA', 210),
      ('DESCONHECIDO', 272),
      ('DESEMPREGADO', 151),
      ('EM DIA', 120),
      ('FALECIDO', 180),
      ('INFOCAD - Informacoes Academicas', 181),
      ('LGPD', 156),
      ('NAO ANOTA RECADO', 211),
      ('NAO PAGARA', 970),
      ('NAO_TABULADO', 269),
      ('NEGOCIAÇÃO - FORA DO PRAZO', 935),
      ('NEGOCIARA EM OUTRO MOMENTO', 379),
      ('NEGOCIOU EM OUTRA ASSESSORIA', 368),
      ('PAGAMENTO NAO PROCESSADO', 219),
      ('Pagara no portal do aluno', 160),
      ('PAGOU EM DIA', 360),
      ('PAGOU NO PORTAL DO ALUNO', 362),
      ('Pediu contato em outro momento', 161),
      ('Pensara sobre proposta apresentada', 162),
      ('PREVENTIVO', 306),
      ('PROBLEMAS_DE_SAUDE', 305),
      ('Processo', 163),
      ('PROMESSA PIX', 924),
      ('Proposta do devedor', 164),
      ('RECADO', 112),
      ('RECUSA CONFIRMAR DADOS PESSOAIS', 363),
      ('RECUSA DE PAGAMENTO', 220),
      ('Recusa de voucher - Nao aceitou renovar', 165),
      ('RECUSA_CONF_POSITIVA', 264),
      ('Reenvio de boleto', 166),
      ('RETORNO AGENDADO COM CLIENTE', 942),
      ('SE MATRICULOU MAS NAO ESTUDOU', 366),
      ('Sem condicoes financeiras', 167),
      ('SEM DEBITO NO SISTEMA', 227),
      ('SEM PREVISÃO PARA PAGAMENTO', 934),
      ('Sem Tabulação', 16),
      ('SOLICITA CONTATO POR WHATSAPP', 373),
      ('TRANCOU MATRICULA', 367),
      ('VAI_PAGAR_NA_REMATRICULA', 286)
    ) AS t(name, codigo_olos)
    LOOP
      INSERT INTO wacrm.tags (account_id, user_id, name, codigo_olos, color)
      SELECT v_account.id, v_account.owner_user_id, v_seed.name, v_seed.codigo_olos, '#64748b'
      WHERE NOT EXISTS (
        SELECT 1 FROM wacrm.tags
        WHERE account_id = v_account.id AND name = v_seed.name
      );
    END LOOP;
  END LOOP;
END $$;

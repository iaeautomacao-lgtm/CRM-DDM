-- Migration 145: tira o token da API DDM da configuração dos nós de fluxo.
--
-- ⚠️ APLICAR SÓ DEPOIS DO DEPLOY do código que entende {{secret.DDM_TOKEN}}
-- (src/lib/ai/tool-secrets.ts). Antes disso, a URL iria com o marcador
-- literal e a API DDM recusaria a consulta.
--
-- As tools do nó de IA guardavam o token em texto na URL
-- ("…/localiza_dev.php?tk=<token>&cpf={{cpf}}"). Aqui o valor de tk= em
-- URLs da ddmacordos.com vira o marcador, resolvido no servidor a partir de
-- DDM_ACORDOS_API_TOKEN. Depois disso:
--   1. trocar o token na DDM (o antigo ficou exposto);
--   2. atualizar DDM_ACORDOS_API_TOKEN no .env do servidor e reiniciar.
--
-- Idempotente: nós já com o marcador não mudam.
--
-- Limitação conhecida (incidente 08/10): a classe [^&"{}]+ para em `{`/`}`. Um token com
-- chave no meio é cortado ali e o resto fica colado depois do marcador (a DDM responde
-- TOKEN INVALIDO). O SQL abaixo já foi aplicado e não muda; fluxos importados depois são
-- tratados no código (sanitizeImportedSecrets em src/lib/ai/tool-secrets.ts, usado por
-- /api/flows/import), cuja regex vai até `&`, `#` ou o fim e não para em chaves.

BEGIN;

DO $$
DECLARE
  v_count integer;
BEGIN
  UPDATE wacrm.flow_nodes
  SET config = regexp_replace(
        config::text,
        '(ddmacordos\.com[^"]*?[?&]tk=)[^&"{}]+',
        '\1{{secret.DDM_TOKEN}}',
        'g'
      )::jsonb
  WHERE config::text ~ 'ddmacordos\.com[^"]*?[?&]tk=[^&"{}]+';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'Nós atualizados (token → {{secret.DDM_TOKEN}}): %', v_count;
END;
$$;

COMMIT;

-- Conferência (deve voltar 0 linhas):
-- select id, node_key from wacrm.flow_nodes
-- where config::text ~ 'ddmacordos\.com[^"]*?[?&]tk=[^&"{}]+';

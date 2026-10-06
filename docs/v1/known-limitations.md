# Limitações conhecidas da V1

## Histórico de schema

Produção passou por reconciliação; `app_schema_version()` não representa sozinho todo o estado live.

## Um provider de IA por conta

O nó escolhe modelo dentro do provider da conta. Não há credenciais independentes OpenAI/Claude/Gemini por nó.

## `api_model`

O código suporta fallback futuro, mas a coluna não existe no schema live do baseline.

## Collect Input

A validação email/phone/regex é declarada, porém não aplicada pelo runner da V1.

## Flow simulator

Não existe na V1. Está no PR #60.

## Disparador V2

Pausa automática por taxa de erro e robustez adicional estão no #62.

## Intelligence V2

Audit origin e MCP resources estão no #63.

## Acessibilidade V2

Rodada do #57 não integra a V1.

## Inbox V2

Remoção de “Negócios ativos” está no #70.

## Tabulação IA V2

Sugestão persistida por exit tag e histórico de aceite estão no #71.

## Dependências externas

Meta, WAHA, LLMs, DDM Acordos, UTMPay e Supabase continuam sendo pontos externos de disponibilidade.

## Dados históricos

Algumas métricas possuem `reliable_since`; períodos anteriores às migrations correspondentes podem ter precisão diferente.

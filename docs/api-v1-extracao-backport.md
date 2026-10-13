# Extração de conversas e mensagens da API V1

**Origem:** `v2` (TASK38), adaptada para `main`. Base de produção após deploy: `https://omnicrm.grupoddm.ia.br/api/v1`.

## Incluído
- `GET /conversations` (`conversations:read`): filtro `updated_from` ou `closed_from`, paginação, status, equipe, telefone, operador, tabulação e transferências.
- `GET /conversations/{id}/messages` (`messages:read`): histórico completo de mensagens em ordem cronológica, autor, texto, template e metadados de mídia.
- `GET /messages?from=...&to=...` (`messages:read`): mensagens de todas as conversas no período (até 31 dias por consulta), independentemente da data de criação da conversa.
- URLs internas de mídia somente quando `include_media_urls=true`, após validação da pasta da própria conta; URLs assinadas expiram em 15 minutos.
- Paginação keyset, auditoria das extrações e limite adicional de 60 requisições/minuto por chave.

## Banco e implantação
1. Validar em homologação o SQL `supabase/migrations/330_api_v1_conversation_extract.sql` e sua compatibilidade com o schema V1.
2. Antes de publicar o código, aplicar esta migration na V1, que cria `messages.origin` e trigger mínimo e as RPCs `api_v1_messages` e `api_v1_conversation_message_counts`. Não requer aplicar a migration 302 completa.
3. Opcional, mas recomendado para extrações de grande volume: executar os comandos SQL dos arquivos `330b_conversations_account_updated_idx.sql` e `331b_conversations_account_closed_idx.sql` separadamente e fora de transação, em horário controlado.
4. Executar testes de isolamento por conta, paginação, leitura de anexos, lint, typecheck e build; validar os endpoints com chave restrita.
5. Fazer merge/restart somente após a validação. **Este PR não executa nenhuma migration, merge ou deploy.**

## Limitações
- Históricos antigos de mensagens de bot podem não ter origem detalhada: sem `messages.origin`, a API classifica como `automation`; instrumentar os escritores antigos é trabalho futuro.
- Não inclui a interface V2 nem sua arquitetura de papéis, webhooks externos, rotinas de disparador ou outras migrations.
- Campos sensíveis (CPF, dados internos de IA e notas privadas) não são retornados.

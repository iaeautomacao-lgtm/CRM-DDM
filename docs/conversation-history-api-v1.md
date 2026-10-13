# API V1 — Histórico completo de conversas

**Status:** PR #427, aguarda migrations, CI e deploy. **Não chamar em produção até sua publicação.**
Base de produção: https://omnicrm.grupoddm.ia.br/api/v1

## Autenticação e LGPD

Todas as chamadas públicas exigem header Authorization: Bearer <API_KEY>.
A API key é vinculada a uma única conta; os dados de outra conta são invisíveis mesmo quando o UUID é conhecido.

- Scope **conversations:read**: listagem, histórico de mensagens, consulta em lote e links privados de mídia.
- Scope **conversations:export**: solicitar exportações, consultar status e obter download de cada parte; também pode consultar o link de mídia associado.
- Não conceda scopes de leitura integral/exportação às chaves existentes sem revisão de privilégio: as conversas contêm CPF, dados financeiros, áudios e outros dados pessoais.
- Armazene chaves e artefatos somente em sistemas autorizados e com política de retenção. Nunca encaminhe URLs assinadas ou conteúdos dos atendimentos para logs, planilhas públicas ou LLMs externos sem base legal e autorização.
- Acesso técnico não equivale a permissão organizacional: proprietário/administrador deve aprovar a chave dedicada do Planejamento.
- Respostas da API V1 usam {data:...} ou {error:{code,message}} e limite usual de 120 requests/min por chave.

## 1. Listagem filtrada

GET /api/v1/conversations?from=2026-10-13&to=2026-10-13&limit=50

Filtros opcionais: from, to (data de criação, calendário Brasília), status (open|pending|closed), agent_id, team_id, channel_type, limit (1..100), cursor.
A listagem é ordenada por created_at e id crescentes, com cursor estável em caso de empate.
Retorna itens com ID, contato, operador/equipe, status, canal, origem, horários, tabulação e estado de processamento IA.

Exemplo (somente estrutura):
{
  "data": {
    "items": [{"id":"...","status":"open","contact":{"id":"...","name":"Contato"}}],
    "next_cursor":"..."
  }
}

Continue até next_cursor ser null.

## 2. Histórico integral individual

GET /api/v1/conversations/{id}/messages?limit=100

Paginação por cursor até o final, limite 1..500 por página. As mensagens vêm em ordem de created_at, id,
com o corpo completo original (content_text), sender_type (customer|agent|bot), sender_id,
content_type, template_name, status, received_at, referência de resposta e mídia.

Em anexos do bucket privado chat-media, cada mensagem traz media_download_url:
GET /api/v1/conversations/{id}/messages/{messageId}/media

A rota retorna {data:{url,expires_in_seconds:60}} após conferir escopo, conta,
conversa e mensagem. O integrador baixa o arquivo diretamente pela URL temporária.
A API não busca URLs externas: mensagens com media_url hospedada em terceiros
ou com proxy legado não compatível continuam com metadados/referência original,
mas podem não ter download direto por esta rota. Não confundir referência de mídia com arquivo presente no bucket.

## 3. Histórico em lote

POST /api/v1/conversations/messages/batch
Content-Type: application/json

{
  "conversation_ids": ["11111111-1111-4111-8111-111111111111"],
  "limit": 100,
  "cursors": {}
}

De 1 a 20 conversas distintas por chamada, até 100 mensagens por conversa.
Retorna data.conversations com {conversation_id,items,next_cursor} para cada conversa.
O cliente deve iterar separadamente o cursor de cada conversa até chegar a null.
Conversa de outra conta gera 404 e nenhuma mensagem do lote é liberada.

## 4. Exportação assíncrona completa (NDJSON.gz)

POST /api/v1/conversations/exports
Content-Type: application/json

{
  "from": "2026-10-01",
  "to": "2026-10-13",
  "status": "closed"
}

Filtros: from e to obrigatórios, 1 a 366 dias inclusivos, mais agent_id, team_id,
channel_type e status opcionais. Limite de três jobs pendentes/em execução por conta.
O POST valida os filtros, registra o snapshot_at e responde 202 sem tentar processar o lote
na mesma requisição:

{"data":{"id":"uuid","status":"queued","poll_url":"/api/v1/conversations/exports/uuid","expires_at":"..."}}

GET /api/v1/conversations/exports/{id}

Retorna status queued|running|completed|failed|expired, snapshot_at, métricas,
erro genérico, parts (somente quando completed) e next_part_no.
Se houver mais de 100 partes, continue com ?after_part_no=N até next_part_no=null.

GET /api/v1/conversations/exports/{id}/parts/{partId}/download

Só aceita jobs concluídos, ainda válidos e da conta da chave.
Retorna {data:{url,file_name,expires_in_seconds:60}}.
Cada arquivo é um **gzip de NDJSON** (application/gzip), com registros intercalados:

{"record_type":"conversation","conversation_id":"uuid","data":{"id":"uuid","status":"open",...}}
{"record_type":"message","conversation_id":"uuid","data":{"id":"uuid","sender_type":"customer","content_text":"...",...}}

Junte as partes pela ordem part_no. Uma conversa longa pode atravessar várias partes:
o registro conversation aparece apenas quando ela começa, e as mensagens
subsequentes preservam a ordem original. O conjunto de mensagens é limitado pelo
snapshot_at; metadados mutáveis (por exemplo status/atribuição) podem refletir
o instante de processamento posterior ao snapshot.

**Retenção:** sete dias desde a criação do job. Após a expiração,
os links deixam de ser emitidos e os objetos são removidos pelo cron,
sem tornar o bucket público.

## 5. Aplicação e operação (cPanel / produção)

1. Revisar e aplicar **supabase/migrations/194_conversation_export_jobs.sql**
   no projeto Supabase de produção *antes* do deploy.
   A migration cria as tabelas privadas wacrm.conversation_export_jobs
   e wacrm.conversation_export_parts, o bucket privado
   conversation-history-exports e a RPC transacional
   claim_conversation_export_job() restrita a service_role.
   Não altera dados legados nem a tabela export_history usada pelo relatório.
2. Configurar **AUTOMATION_CRON_SECRET** no app, se ainda não configurado.
   Usar a mesma variável já necessária aos crons de automações/fluxos.
3. Cadastrar cron do cPanel **a cada minuto** para chamar o endpoint
   POST https://omnicrm.grupoddm.ia.br/api/cron/conversation-exports
   com header x-cron-secret: $AUTOMATION_CRON_SECRET.
   Esta rota não usa a chave pública do Planejamento.
   O GET da mesma rota serve de health check autenticado.
4. Conferir que o processo do Next.js pode assinar e gravar no bucket privado
   usando SUPABASE_SERVICE_ROLE_KEY, sem exibir credenciais na resposta.
5. Rodar lint, typecheck, testes, build, e testes end-to-end com duas contas
   antes de publicar. Criar uma API key **nova** com os scopes mínimos e revisar
   chaves antigas que já possuíam conversations:read.
6. Validar a limpeza em conta de teste, a recuperação após interrupção do cron,
   as partes de um histórico longo e a leitura da mídia privada com chave válida e inválida.

**Não é necessário executar SQL por exportação:** somente a migration inicial.
O worker busca jobs com lease atômica (evita execução concorrente), lê páginas limitadas,
envia partes compactadas para Storage e salva progresso. Em falhas transientes,
tenta novamente com backoff limitado (máximo cinco falhas consecutivas).
A expiração dos artefatos depende de o cron permanecer ativo.

### Exemplo de agendamento com curl

Usar o agendador do cPanel com credenciais armazenadas no ambiente do servidor,
não em comandos versionados ou scripts públicos:

    curl --fail --silent --show-error --max-time 45 -X POST \
      -H "x-cron-secret: $AUTOMATION_CRON_SECRET" \
      "https://omnicrm.grupoddm.ia.br/api/cron/conversation-exports"

**Limitações transparentes:** o arquivo exporta as mensagens armazenadas no CRM
até o snapshot, não os binários de mídia nem possíveis mensagens excluídas da base.
Acesso a arquivos privados chat-media usa endpoint assinado individual; mídias externas
permanecem dependentes do provedor. Dados exportados precisam ser protegidos pelo cliente.

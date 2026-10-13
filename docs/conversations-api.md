# API V1 — Conversas completas, lotes e exportações

Base URL: https://omnicrm.grupoddm.ia.br

A API pública de conversas foi criada para permitir que o Planejamento analise
atendimentos completos **sem abrir cada conversa no Inbox**.

## Segurança e implantação

- **Leitura:** chave de conta com `conversations:read`. Não é liberada por `reports:read`,
  `messages:read` nem `intelligence:read`.
- **Exportação:** escopo separado `conversations:export`, que permite gerar e baixar
  cópias completas das conversas (dados pessoais sensíveis). Não conceda esse escopo
  a integrações que só precisam de relatórios agregados.
- Cada rota usa `requireApiKey`, rate limit de 120 req/min/chave e filtro
  explícito pelo account_id da chave. UUID de outra conta gera 404 idêntico a
  conversa inexistente. No lote, um único ID fora da conta invalida toda a
  requisição (sem resultado parcial).
- As respostas têm `Cache-Control: private, no-store`. Não registre textos,
  CPFs, anexos ou chaves em logs de integração.
- **Obrigatório antes do deploy das exportações**: aplicar
  `supabase/migrations/194_public_conversation_exports.sql` no banco da V1.
  Cria `wacrm.conversation_export_jobs` e o bucket privado
  `conversation-api-exports`, sem políticas públicas de leitura.
- Configurar cron no cPanel: POST
  `https://omnicrm.grupoddm.ia.br/api/cron/conversation-exports` a cada minuto,
  com header `x-cron-secret: <AUTOMATION_CRON_SECRET>`. A criação do job **não
  executa** a exportação dentro da requisição; sem o cron ela fica `queued`.
  Cron processa um job por tick, com compare-and-swap e recuperação de timeout.
- Produção: aguardar CI (unit/typecheck/build), aplicar migration e configurar
  cron; depois fazer deploy da branch principal. Não habilitar exportações
  antes de preparar a infraestrutura.

## 1. Listar conversas

```http
GET /api/v1/conversations?from=2026-10-13&to=2026-10-13&status=active&limit=50
Authorization: Bearer wacrm_live_...
```

Filtros: `from`, `to` (data de **criação** da conversa, calendário de Brasília,
ambos opcionais; máximo de 366 dias entre eles), `status` (`all`, `active`,
`attending`, `waiting`, `open`, `pending`, `closed`), `team_id`,
`agent_id`, `contact_id`, `channel`, `q` (nome/telefone do contato).
Páginas de 1 a 100, ordenadas por `created_at DESC, id DESC`.

```json
{
  "data": {
    "conversations": [
      {
        "id": "11111111-1111-4111-8111-111111111111",
        "status": "open",
        "contact": { "id": "22222222-2222-4222-8222-222222222222", "name": "Cliente", "phone": "5521999990000" },
        "assigned_agent_id": "33333333-3333-4333-8333-333333333333",
        "assigned_agent_name": "Operadora",
        "team_id": null,
        "team_name": null,
        "channel_type": "whatsapp",
        "control_state": "human",
        "created_at": "2026-10-13T14:20:00Z"
      }
    ],
    "next_cursor": null,
    "has_more": false
  }
}
```

O `control_state` representa a atribuição/heartbeat observado, não
comprova que um operador está digitando: `human` quando existe atribuição,
`ai_processing` quando há heartbeat recente da IA (90s), ou
`unassigned` nos demais casos. Para saber o histórico real do fluxo,
consulte o endpoint de eventos.

## 2. Consultar uma conversa

```http
GET /api/v1/conversations/{id}
Authorization: Bearer wacrm_live_...
```

Retorna os mesmos metadados do item da listagem.

## 3. Ler TODAS as mensagens de uma conversa

```http
GET /api/v1/conversations/{id}/messages?limit=200
Authorization: Bearer wacrm_live_...
```

Mensagens em ordem `created_at ASC, id ASC`, incluindo mensagens antigas,
textos **sem truncamento**, tipos `customer`, `agent` e `bot`, horários,
`content_type`, `content_text`, `sender_name` para agente,
`media_url`, `media_available`, nome de template, IDs de resposta,
status, dados interativos e campanhas.

```json
{
  "data": {
    "conversation_id": "11111111-1111-4111-8111-111111111111",
    "messages": [
      {
        "id": "44444444-4444-4444-8444-444444444444",
        "sender_type": "customer",
        "content_type": "text",
        "content_text": "Gostaria de verificar meus débitos",
        "created_at": "2026-10-13T14:20:03Z",
        "media_url": null,
        "media_available": false
      }
    ],
    "next_cursor": null,
    "has_more": false
  }
}
```

Quando `next_cursor` não for nulo, **repita a requisição** usando
`?cursor=<valor>`; pare somente quando vier `null`.
Não existe limite fixo de "últimas 200 mensagens": 200 é o tamanho máximo
de **cada página**, não de todo o histórico.

Mídias: são retornadas as referências armazenadas no CRM, não os arquivos em
Base64. Se o provedor não tiver preservado os bytes ou se a URL antiga tiver
expirado, a API não pode reconstruir o arquivo. Evite repassar URLs sensíveis
a terceiros. Anexos preservados em Storage dependem das permissões do arquivo
original; este endpoint não cria URLs assinadas para buckets de mídia.

## 4. Eventos de IA, transferências e mudanças de estado

```http
GET /api/v1/conversations/{id}/events?type=flow&limit=200
GET /api/v1/conversations/{id}/events?type=assignment&limit=200
GET /api/v1/conversations/{id}/events?type=status&limit=200
```

Cada categoria usa seu próprio `next_cursor` até esgotar. Os eventos de
fluxo contêm nó, tipo, status, duração e horário, sem argumentos ou resultados
brutos de Tools. Atribuições contêm IDs de atendentes/equipes, ator e motivo.
Auditoria de status inclui apenas campos permitidos de alteração, sem
`ip_address`, `user_agent`, credenciais ou payload de integrações.

## 5. Recuperar vários históricos por requisição

```http
POST /api/v1/conversations/messages/batch
Authorization: Bearer wacrm_live_...
Content-Type: application/json
```

```json
{
  "conversation_ids": [
    "11111111-1111-4111-8111-111111111111",
    "55555555-5555-4555-8555-555555555555"
  ],
  "limit_per_conversation": 100,
  "cursors": {}
}
```

Até 10 conversas e 100 mensagens **por conversa** por request. A resposta é
`data.conversations[]`, contendo para cada ID `messages`, `next_cursor`
e `has_more`. Para continuar, envie `cursors` indexados pelo UUID,
independentemente para cada conversa, até que todos sejam `null`.
Até 1000 mensagens por chamada, sem truncamento silencioso.

## 6. Exportação assíncrona

```http
POST /api/v1/conversations/exports
Authorization: Bearer wacrm_live_...
Content-Type: application/json
```

```json
{
  "from": "2026-10-01",
  "to": "2026-10-13",
  "status": "all",
  "max_conversations": 500
}
```

Retorna 202 com `job_id`, `status=queued` e `status_url`. Cada chave pode
manter até dois jobs pendentes. Uma requisição de exportação é uma página de
até 500 conversas; se existirem mais, o arquivo conterá
`export_footer.next_cursor` e o endpoint de status também retornará
`next_cursor`. Faça novo POST com o **mesmo filtro e esse cursor** para a
próxima parte. Para exportar tudo, continue até `next_cursor=null`.

```http
GET /api/v1/conversations/exports/{job_id}
Authorization: Bearer wacrm_live_...
```

A API retorna `queued`, `processing`, `completed` ou `failed` e contagens.
Somente a **mesma chave e mesma conta** que criou o job conseguem ler.
`completed` retorna `download_url` (assinada por 10 minutos) enquanto
o job estiver válido por 24h. Bucket não é público. O cron remove os
arquivos expirados. Exportações acima de 25 MB ou 100 mil linhas falham com
`file_too_large_split_period` ou `too_many_records_split_period`:
reduza o período, filtros ou a quantidade de conversas.

Formato NDJSON UTF-8, uma linha JSON por registro:
- `export_header`: versão e horário;
- `conversation`: contato, responsável, estado e datas;
- `message`: mensagem **integral**, mídia referenciada e autor;
- `event`: tipo `flow` / `assignment` / `status`, com campos sensíveis removidos;
- `export_footer`: contagens e `next_cursor`.

Não confundir `conversations:export` com a Reporting API: `reports:read`
continua devolvendo somente indicadores agregados sem transcrições.

## Testes recomendados antes de liberar

1. Key sem `conversations:read` → 403 nas cinco rotas de consulta.
2. Conversa de outra conta → 404; lote com UUID de outra conta → 404, sem
   mensagens das demais conversas.
3. Conversa com mais de 200 mensagens → paginação até a primeira, sem
   mensagens repetidas ou truncadas.
4. Testar textos longos, anexos, bot/agente/cliente e timestamps iguais.
5. Chave com `conversations:read` mas sem `conversations:export` → 403 no POST.
6. Job e download de outra API key → 404, inclusive na mesma conta.
7. Cron não autorizado → 401; migração/bucket ausentes → erro, não
   "completed" falso. Arquivo exportado precisa permanecer privado.

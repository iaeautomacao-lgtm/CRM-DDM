# CRM Reporting API

A Reporting API expõe métricas agregadas do CRM para Power BI, Metabase,
n8n e integrações de relatórios sem fornecer acesso direto ao PostgreSQL ou
ao Supabase.

Base:

```
/api/v1/reports
```

Autenticação:

```
Authorization: Bearer wacrm_live_xxx
```

Todas as rotas abaixo exigem o scope `reports:read`. A API key é vinculada
a uma única conta; o `account_id` nunca é recebido do integrador e é
resolvido pelo servidor a partir da chave.

## Convenções

- Datas históricas usam `from=YYYY-MM-DD&to=YYYY-MM-DD`.
- `from` e `to` são inclusivos e representam o calendário de Brasília
  (`America/Sao_Paulo`).
- Um request cobre no máximo 366 dias. Para intervalos maiores, consulte em
  blocos e una no BI.
- Filtros opcionais: `team_id=<uuid>` e `agent_id=<uuid>`.
- As respostas seguem o envelope da API v1: `{ "data": ... }`.
- Nenhuma rota retorna mensagens, CPF, credenciais, tokens ou configuração
  sensível. São endpoints de relatório, não uma API de SQL.

## Definições operacionais

As métricas usam as mesmas regras do Monitoramento:

- **Navegando**: conversa `open` sem operador atribuído.
- **Em espera**: conversa `pending` sem operador atribuído.
- **Em atendimento**: conversa ativa com `assigned_agent_id`; a atribuição
  vence o status bruto.
- **Atendida**: primeira resposta humana (`first_response_at`) ocorreu no
  período. O timestamp é alimentado pelo trigger de SLA quando uma mensagem
  de operador possui `sender_id`; respostas automáticas (`bot`) não contam.
- **Finalizada**: `closed_at` ocorreu no período.
- **Tabulada**: conversa finalizada no período com `outcome_tag_id`.
- **Online / Ausente / Offline**: derivados do heartbeat já usado pelo CRM.
- **Serving / Em atendimento** do operador: possui ao menos uma conversa
  ativa atribuída naquele instante.

## GET /operations/current

Snapshot operacional agora.

```bash
curl "https://crm.example.com/api/v1/reports/operations/current" \
  -H "Authorization: Bearer wacrm_live_xxx"
```

Exemplo:

```json
{
  "data": {
    "generated_at": "2026-10-07T14:00:00.000Z",
    "conversations": {
      "total_active": 184,
      "navigating": 72,
      "waiting": 31,
      "attending": 81
    },
    "operators": {
      "total": 48,
      "online": 24,
      "away": 6,
      "offline": 18,
      "serving": 19
    },
    "teams": []
  }
}
```

Aceita `team_id` e `agent_id` para snapshots filtrados.

## GET /operations/summary

Resumo de um período + snapshot atual.

```
GET /api/v1/reports/operations/summary?from=2026-10-01&to=2026-10-07
```

`attendances` inclui:

- `received`
- `attended`
- `closed`
- `tabulated`
- `without_tabulation`
- `distinct_tabulations`
- `unique_operators`
- `avg_first_response_seconds`
- `avg_resolution_seconds`
- `avg_service_seconds`

Definição dos tempos:

- `avg_first_response_seconds`: `created_at → first_response_at` nas conversas cuja primeira resposta ocorreu no período.
- `avg_resolution_seconds`: `created_at → closed_at` nas conversas finalizadas no período.
- `avg_service_seconds`: `first_response_at → closed_at` nas conversas finalizadas no período que possuem primeira resposta humana registrada.

Os três indicadores são deliberadamente separados: tempo total de resolução não é tratado como tempo de atendimento humano. Quando não há amostra válida, a média é `null`.

## GET /teams

Métricas históricas e atuais por equipe.

```
GET /api/v1/reports/teams?from=2026-10-01&to=2026-10-07
```

Cada equipe contém `period` (atendimentos/tabulações/tempos) e `current`
(fila atual e operadores online/away/offline/serving).

## GET /agents

Métricas por operador.

```
GET /api/v1/reports/agents?from=2026-10-01&to=2026-10-07
GET /api/v1/reports/agents?from=2026-10-01&to=2026-10-07&team_id=<uuid>
```

Retorna presença atual, equipes do operador, atendimentos do período e
quantidade de conversas em atendimento agora.

> A atribuição histórica usa o `assigned_agent_id` registrado na conversa.
> Se uma conversa foi transferida, o relatório por operador representa o
> responsável final registrado na conversa; o histórico detalhado de
> transferências não é redistribuído nesta versão.

## GET /tabulations

Distribuição de tabulações de encerramento.

```
GET /api/v1/reports/tabulations?from=2026-10-01&to=2026-10-07
GET /api/v1/reports/tabulations?from=2026-10-01&to=2026-10-07&team_id=<uuid>
GET /api/v1/reports/tabulations?from=2026-10-01&to=2026-10-07&agent_id=<uuid>
```

Exemplo:

```json
{
  "data": {
    "total_closed": 8421,
    "total_tabulated": 8102,
    "without_tabulation": 319,
    "distinct_used": 22,
    "items": [
      {
        "tabulation_id": "...",
        "code": 142,
        "name": "Acordo Realizado",
        "count": 1864,
        "percentage": 23.01
      }
    ]
  }
}
```

`percentage` é calculado sobre o total de conversas tabuladas, não sobre
todas as finalizadas.

## Segurança

A implementação usa o mesmo sistema de API keys da API pública:

- chave armazenada apenas como hash;
- revogação imediata;
- rate limit por chave;
- auditoria em `system_logs`;
- `reports:read` não concede leitura bruta de contatos ou mensagens;
- o servidor usa service role internamente, mas toda consulta recebe
  explicitamente o `account_id` resolvido pela API key.

Não existe parâmetro `account_id`, `table`, `select` ou SQL arbitrário
na superfície pública.

@AGENTS.md

# CRM-DDM — Guia para IA

## Stack
- Next.js 16 (App Router) + TypeScript
- Supabase (PostgreSQL, schema `wacrm`, produção: projeto `cyftbffhgjmsfogxawrl`)
- Meta Cloud API + WAHA (api.meuchatia.com.br)
- OpenAI GPT-4o-mini
- Phusion Passenger em `grpia@server.ddmsrv.com ~/apps/omnichannel`
- shadcn/ui, Tailwind CSS

## Deploy (invariante — nunca pular etapas)
```bash
git pull && nvm use 20.19.0 && npm run build && touch tmp/restart.txt
```
Sempre rodar `npx tsc --noEmit` antes de commitar. Zero erros de tipo obrigatório.

## Estrutura de Pastas
```
src/
  app/(dashboard)/     → páginas do CRM (inbox, disparador, flows, etc.)
  app/api/             → rotas de API (Next.js route handlers)
  lib/
    disparador/        → startCampaign.ts, processQueueItem.ts
    flows/engine.ts    → motor de automações e Flow Builder
    ai/responder.ts    → respostas automáticas via OpenAI
    supabase/          → clientes Supabase (admin e público)
  components/          → componentes UI reutilizáveis
  types/               → tipos TypeScript centralizados
```

## Bifurcação WAHA vs Meta (regra central do projeto)

Quase toda funcionalidade de envio tem dois caminhos:

- **WAHA**: texto livre, variáveis `{{1}} {{2}} {{3}}` substituídas no código antes do envio, sem template aprovado
- **Meta Cloud API**: templates aprovados pelo Facebook, variáveis enviadas como array `templateVariables` na chamada API, a Meta faz a substituição

Nunca unificar esses dois caminhos — as lógicas são incompatíveis. Sempre bifurcar com `if (isMetaChannel)`.

## Padrões de Código

### PostgREST / Supabase
- `.single()` crasha em múltiplas linhas → usar `.limit(1)` + `[0]`
- Relacionamentos ambíguos exigem hint FK: `contacts!contact_id`
- Queries sempre no schema `wacrm` — nunca schema público
- Paginação obrigatória via `.range()` para tabelas grandes (contacts, messages, disp_message_queue)

### TypeScript
- Usar `??` para defaults, nunca `||` — `||` sobrescreve `0` e `false` indevidamente
```typescript
// ❌ intervalo_min: config.intervalo_min || 90  (0 vira 90)
// ✅ intervalo_min: config.intervalo_min ?? 90
```
- Tipos de status sempre como union literals, nunca `string`

### Phusion Passenger
- `setInterval` e workers em memória NÃO sobrevivem a restarts
- Toda lógica recorrente deve ser cron stateless via `/api/*/cron`
- Passenger gerenciado pelo EasyPanel — `passenger-status` pode retornar erro mesmo com o app rodando

## Gotchas Conhecidos (não "corrigir" sem investigar)

| Gotcha | Motivo |
|---|---|
| `engine.ts` tem truncagem intencional | Decisão deliberada, não commitar sem confirmação |
| `app_secret` pode chegar em plaintext pela UI | Bug de segurança conhecido, bypass da criptografia AES-256-GCM |
| `/api/v1/disparador/campaigns` não chama `startCampaign()` | Lógica própria, não tem `import_draft_id` |
| Migration files podem não refletir produção | Sempre verificar schema live no Supabase SQL Editor antes de escrever migrations |
| `hasRunLeftNodeSnapshot` no engine | Guard anti-race-condition BEN→Aleh, não remover |

## Criptografia
- AES-256-GCM com IV de exatamente 12 bytes
- Formato: `iv:ciphertext:authTag` em hex
- Chave em `ENCRYPTION_KEY` no `.env`

## Variáveis de Ambiente Críticas
```
AUTOMATION_CRON_SECRET     → protege /api/automations/cron
STRESS_RUN_SECRET          → protege /api/stress/run
DDM_ACORDOS_API_TOKEN      → API externa de dívidas DDM
ENCRYPTION_KEY             → criptografia de app_secret
```

## Fluxo de Investigação (padrão do projeto)
1. Investigar → reportar achados
2. Aguardar aprovação
3. Implementar
4. Rodar `tsc --noEmit`
5. Mostrar diff para revisão
6. Commitar só após confirmação

## Migrations
- Aplicadas manualmente no Supabase SQL Editor
- Verificar schema live antes de escrever qualquer migration
- Nunca confiar nos arquivos de migration como fonte de verdade do schema atual

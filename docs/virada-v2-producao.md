# Virada da V2 para produção — checklist

Tudo o que muda quando a V2 deixar de ser `omnicrmv2dev` e passar a atender no domínio de produção. Levantado em 14/10/2026
com o ambiente real da VPS. Atualize este arquivo sempre que entrar algo que dependa de domínio, banco, cron ou segredo.

## 1. Como está hoje

| | V1 (produção atual) | V2 (desenvolvimento) |
|---|---|---|
| Pasta na VPS (`grpia@server.ddmsrv.com`) | `~/apps/omnichannel` | `~/apps/omnichannel-v2-desenvolvimento` |
| Domínio (`NEXT_PUBLIC_APP_URL`) | `https://omnicrm.grupoddm.ia.br` | `https://omnicrmv2dev.grupoddm.ia.br` |
| Banco Supabase | `cyftbffhgjmsfogxawrl` | `mkrkkvbseobdqsalrorl` (separado) |
| Segredos dos crons | escritos na própria linha do crontab | `~/.crm-cron-v2.env` (chmod 600: `CRON_SECRET`, `AUTOMATION_CRON_SECRET`, `APP`) |
| UTMpay | mesma VPS, `utmpay.grupoddm.ia.br` | mesma VPS, `utmpay.grupoddm.ia.br` |

O crontab é **um só** para o usuário da VPS e mistura V1, V2 e outros sistemas (goautodial, juridflow). Linha com
`omnicrm.grupoddm.ia.br` é da V1.

## 2. Checklist da virada

### 2.1 Domínio e app
- [ ] Decidir se a V2 assume `omnicrm.grupoddm.ia.br` (substitui a V1) ou outro domínio.
- [ ] `.env` da V2: `NEXT_PUBLIC_APP_URL` = domínio de produção. Ele é usado em links, convites, webchat e no link rastreado.
- [ ] Webhooks da Meta e da WAHA apontando para o domínio novo (`/api/whatsapp/webhook`, `/api/meta/webhook`,
      `/api/whatsapp/webhook/waha`). Sem isso, nenhuma mensagem chega.
- [ ] Redirect URLs do Supabase Auth (Site URL e Redirect URLs) com o domínio novo, senão login, convite e recuperação de
      senha quebram.
- [ ] Rodar `npm run schema:check` no banco que vai ficar em produção (deve dar 0 faltando).

### 2.2 Banco
- [ ] Decidir qual banco fica: manter o da V2 (`mkrkkv…`) ou migrar dados da V1 (`cyftbff…`). Se a V2 apontar para o banco
      da V1, **todas** as migrations da V2 precisam estar aplicadas nele antes (conferir com `npm run schema:check`).
- [ ] **376 e 377 vieram da V1 (16/10)** — detalhes em `prd-v2/virada-v1-376-377.md`:
  - A `main` (V1) tem a `376_agent_mention_queue.sql` (PR #476); a branch `feat/v1-dashboard-monthly-ai-meta-costs-20261015` tem a `377_dashboard_costs.sql`. A v2 não tinha nenhuma das duas. **Próximo número livre na v2: 378** (369 reservado ao Farol/W4).
  - Antes de aplicar, conferir no schema vivo da produção se a 376 já foi aplicada (arquivos de migration não são fonte de verdade).
  - Ordem no banco da V1: o que falta da v2 (faixa 304–375, em ordem numérica) → **376** → **378** (metade de IA da 377, se for portada). Não aplicar a 377 original por cima da v2: ela duplica a 195 (custo Meta) e reescreve `ingest_status_events`.
  - A migration 376 vai **antes** do código do `@operador`. O código do #476 ainda **não existe na v2**: portar `agent-mention*.ts`, o gancho em `inbound-message.ts` e na rota WAHA, o filtro `requested_agent_id IS NULL` do `retry-assignment` e o campo no PATCH de membros (lista completa no relatório).
  - Decisões do dono: menção a operador em pausa espera ou cai na distribuição (371)? Custo Meta da V2 vem da 195 ou da 377?

### 2.3 Crons (crontab da VPS)
- [ ] Em `~/.crm-cron-v2.env`, trocar `APP=` para o domínio de produção. As 11 linhas da V2 leem dali; não precisa mexer nelas.
- [ ] Desligar as linhas da V1 (`omnicrm.grupoddm.ia.br/...`) **só** quando a V1 sair do ar. Em especial: `/api/disparador/cron`
      da V1 e da V2 no mesmo banco processariam a mesma fila com códigos diferentes.
- [ ] A linha `/api/automations/cron` é da V1 (a V2 não tem mais Automações legadas). Some junto com a V1.
- [ ] Trocar os segredos fracos da V1 que estavam escritos no crontab (`ddm_secreto_123`, `ddm_flows_secreto_456`,
      `ddm_health_secreto_789`) e que foram expostos em conversa em 14/10.
- [ ] Teste após a troca:
      `. ~/.crm-cron-v2.env; curl -sS -o /dev/null -w "%{http_code}\n" -X POST -H "x-cron-secret: $AUTOMATION_CRON_SECRET" "$APP/api/flows/cron"` → 200.

### 2.4 UTMpay
- [ ] `.env` do UTMpay: `CRM_EVENTS_URL=https://<domínio de produção>/api/integrations/utmpay/events`.
- [ ] `CRM_EVENTS_SECRET` igual ao segredo cadastrado no CRM (Integrações → UTMpay). Se o banco do CRM mudar, recadastrar.
- [ ] `UTM_DESTINOS_PERMITIDOS`: incluir o domínio de produção se algum link de campanha apontar para ele.
- [ ] `UTM_TRUST_PROXY`: `1` se `utmpay.grupoddm.ia.br` passar por Cloudflare/proxy; `0` se apontar direto para a VPS.
- [ ] No CRM, Integrações → UTMpay: URL base, chave (`UTM_API_KEY` do UTMpay), segredo do webhook e janela de atribuição.
- [ ] Detalhes das mudanças do UTMpay, SQL e ordem de deploy: `ANTES-DEPOIS.md` no repositório do UTMpay.

### 2.5 Segredos e integrações
- [ ] Token da API DDM Acordos: o que existia foi exposto; usar um token novo na V2 de produção.
- [ ] Chave do ElevenLabs e credenciais do projeto Supabase antigo (`rpjyrs…`): confirmar que foram trocadas.
- [ ] `ENCRYPTION_KEY`: se o banco da V2 for o de produção, **manter a mesma** chave; trocar torna ilegíveis os segredos
      cifrados (app_secret, tokens de canal, chaves de IA, segredos do UTMpay).
- [ ] Chaves de API da API pública (Integrações → Chaves de API): avisar integradores sobre o domínio novo.

### 2.6 Testes e conferência
- [ ] GitHub Secrets do teste de telas: `E2E_BASE_URL` = domínio de produção (ou manter apontando para um ambiente de
      homologação, com usuários de teste, nunca usuários reais). Ver `docs/e2e-telas.md`.
- [ ] Rodar o teste de telas (Actions → e2e-telas → Run workflow) depois da virada.
- [ ] Conferir: login com 2FA, envio e recebimento no inbox, um fluxo com espera, o Acordito sugerindo, uma campanha de
      teste com link rastreado (clique aparece no Desempenho) e a régua.

## 3. Referências
- Crons: `docs/crons.md` e `ops/crontab.example`.
- Variáveis de ambiente: `docs/env.md`.
- Teste de telas: `docs/e2e-telas.md`.

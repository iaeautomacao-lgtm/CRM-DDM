# Integração UTMpay (métrica clicou → fechou → pagou)

Decisões do dono (14/10/2026). O UTMpay (serviço próprio, Flask/MySQL) rastreia o link de cada envio; o CRM guarda o resultado por envio, atribui quem fechou e confirma o pagamento na API DDM. Contrato de API das telas: `prd-v2/contrato-api-utmpay-crm.md`. Migration: `356_utmpay_integracao.sql`.

## Como funciona

1. **Envio.** A operação continua informando o link que quer (campanha/planilha). Na hora de enviar (`processQueue`), o CRM troca **a primeira URL da mensagem** por um link do UTMpay, **um por envio** (`tid` = id do item da fila); o link que a operação informou vira o **destino**. Todo disparo sai rastreado (sem opt-in), desde que a conta tenha o UTMpay configurado e ligado.
   - **WAHA e Meta em texto livre:** a URL do texto final é trocada.
   - **Meta com template:** a URL tem de estar numa variável `{{n}}`; só a variável é trocada. URL escrita fixa no texto aprovado do template **não** é trocada (fica sem rastreio, com aviso na tela).
   - Os envios simultâneos de uma campanha são agrupados numa única chamada `POST {base_url}/api/gerar-links-lote` (até 1000 por lote).
2. **Se o UTMpay falhar**, o link cru **não sai**: o item volta com o erro "Rastreamento (UTMpay) indisponível…" e é tentado de novo, a menos que a conta marque "enviar sem rastreio se o UTMpay cair".
3. **Eventos.** O UTMpay avisa o CRM em `POST /api/integrations/utmpay/events` (público, assinado). Etapas: `click`, `cpf_view`, `cpf_submit`, `payment_view`, `payment_start`, `paid`.
   - **Clicou** = `click`; **Fechou acordo** = `payment_start`; **Pagou** = `paid` **confirmado na API DDM** (`localiza_dev.php`, campos `situacao_acordo`, `valor_em_aberto`, `instituicao`). `paid` nunca é confiado sozinho.
   - Eventos fora da janela de atribuição (padrão 7 dias após o envio, configurável por conta) ficam gravados mas não viram resultado.
4. **Atribuição** (olha a conversa do contato entre o envio e o evento): sem mensagem do contato ⇒ `direto`; só IA/fluxo respondeu ⇒ `ia`; algum atendente humano respondeu ⇒ `humano` (com o último atendente; humano vence IA). Origem `flow` e `ai` contam como IA (o catálogo de origem não separa fluxo com IA de fluxo sem IA).
5. **Conferência do pagamento.** Se a DDM estiver fora do ar quando chega o `paid`, o evento fica pendente (`pagou_evento_em` sem `pagou_em`) e o cron abaixo confirma depois (até 14 dias).

## Configuração (por conta, pela tela)

`GET/PUT /api/account/utmpay-config` (permissão `settings.account`): `base_url` (https, só origem), `api_key` e `webhook_secret` (write-only, cifrados no servidor), `janela_dias` (1–90, padrão 7), `enabled`, `send_without_tracking` (padrão false). `POST /api/account/utmpay-config/test` testa `GET {base_url}/health`.

- **Chave da API do UTMpay** = `UTM_API_KEY` do UTMpay.
- **Segredo do webhook** = `CRM_EVENTS_SECRET` do UTMpay (mesmo valor).
- **`CRM_EVENTS_URL` do UTMpay** = `https://<domínio do CRM>/api/integrations/utmpay/events` (a tela mostra o endereço pronto: `events_url`).
- **Token da DDM:** reaproveita o que já existe (`DDM_ACORDOS_API_TOKEN` / `DDM_TOKEN` / `DDM_API_KEY`, `src/lib/billing/ddm-source.ts`); nenhum token novo.

## Segurança do webhook

Cabeçalhos `X-UTMpay-Timestamp` (unix s) e `X-UTMpay-Signature: sha256=hex(HMAC_SHA256(secret, timestamp + "." + corpo))`. O CRM usa o segredo da **conta dona do `tid`**; assinatura inválida, `tid` desconhecido e conta sem segredo respondem o mesmo 401; relógio fora de ±5 min é recusado; idempotente por `event_id`; corpo até 8 KB; sem CPF. A atribuição e a consulta à DDM rodam depois da resposta (2xx rápido).

## Cron na VPS (novo)

`POST /api/integrations/utmpay/recheck` com `x-cron-secret: $AUTOMATION_CRON_SECRET`, a cada ~15 min: reconfere os `paid` ainda não confirmados pela DDM (até 50 por chamada). Pode reaproveitar o mesmo agendador do `/api/flows/cron`.

## Ordem de deploy

1. Rodar o SQL do UTMpay (`migracao_url_destino.sql`) e configurar o `.env` dele (`UTM_DESTINOS_PERMITIDOS`, `UTM_WEBHOOK_SECRET`, `UTM_TRUST_PROXY`), conforme `ANTES-DEPOIS.md` do UTMpay.
2. Aplicar a migration 356 no CRM (depende só da 240; antes ou depois do deploy do app).
3. Subir o app; configurar o UTMpay na tela (base_url, chave, segredo) e testar a conexão.
4. Só então ligar `CRM_EVENTS_URL`/`CRM_EVENTS_SECRET` no UTMpay.

## Limites conhecidos

- Só a **primeira** URL da mensagem é rastreada. Link em template Meta fixo no texto aprovado não é rastreado.
- O UTMpay só aceita destino `https` em domínio de `UTM_DESTINOS_PERMITIDOS`; fora da lista o link não é gerado e o envio não sai (erro no item).
- Contato sem CPF vai ao UTMpay como `crm-<id do contato>` (o checkout não pré-preenche o CPF) e não tem confirmação na DDM (sem CPF não há consulta): o `paid` dele fica pendente.
- A DDM não distingue com certeza "paga" de "removida": hoje "lista vazia" ou `situacao_acordo` paga/quitada contam como quitada (premissa do dono, a confirmar com a DDM).

# Stress test suite — CRM-DDM

Suite de testes de carga para encontrar gargalos antes do go-live. Todos os
dados fictícios criados são prefixados `STRESS_TEST` para serem fáceis de
identificar e apagar depois com `npm run stress:cleanup`.

## O que cada script faz

| Script | Comando | O que testa |
|---|---|---|
| `generate-csv.ts` | `npm run stress:generate` | Gera CSVs fictícios (100–10000 linhas) em `tests/stress/data/` |
| `test-import.ts` | `npm run stress:import` | Importa cada CSV via `/api/disparador/contacts/import`, mede tempo/taxa de sucesso |
| `test-queue.ts` | `npm run stress:queue` | Cria uma campanha de teste, importa 1000 contatos, inicia e monitora a fila (`disp_message_queue`) até drenar |
| `test-webhook.ts` | `npm run stress:webhook` | Carga concorrente em `/api/whatsapp/webhook` **local**, mede p50/p95/p99 e testa o UNIQUE de `message_id` sob redelivery |
| `report.ts` | `npm run stress:report` | Consolida os JSONs de resultado num relatório único |
| `cleanup.ts` | `npm run stress:cleanup` | Remove todos os dados STRESS_TEST criados pelos testes acima |

Ordem recomendada: `generate` → `import` → `queue` → `webhook` → `report` →
`cleanup`.

## Health check automatizado (produção)

Diferente dos scripts acima (manuais, sob demanda, usam dados fictícios),
`POST /api/stress/run` é um health check leve pensado pra rodar sozinho
todo dia em produção — sem CSV, sem dado fictício, só smoke tests e
contagens de saúde do banco. Resultado aparece na aba **Testes** de
`/ddm-logs` (histórico das últimas 50 execuções, com botão "Rodar agora").

Protegido por header `x-stress-secret` (env `STRESS_RUN_SECRET` — ver
`.env.local.example`). Sem essa env configurada, a rota responde 503;
com o header ausente ou errado, 401.

### Configurar o crontab do servidor

Adicione ao crontab (cPanel → Cron Jobs, ou `crontab -e` direto no
servidor) — roda todo dia às 2h:

```
0 2 * * * curl -s -X POST \
  -H "x-stress-secret: <STRESS_RUN_SECRET>" \
  https://omnicrm.grupoddm.ia.br/api/stress/run \
  >/dev/null 2>&1
```

Troque `<STRESS_RUN_SECRET>` pelo valor real configurado no `.env` de
produção. O `>/dev/null 2>&1` é só pra não gerar e-mail de cron a cada
execução — o resultado já fica gravado em `system_logs` e visível na
aba Testes, não precisa do output do curl.

**Nota:** dois dos sete testes (`smoke_cron_disparador`,
`smoke_cron_flows`) chamam as rotas de cron reais de produção, não um
mock — isso é intencional (ver comentários em
`src/app/api/stress/run/route.ts`). `smoke_cron_flows` em particular dá
ao sweep de timeout de flows (`/api/flows/cron`) uma execução garantida
por dia mesmo que nenhum outro agendador externo esteja configurado
pra ele.

## Variáveis de ambiente

Nenhum script lê `.env` automaticamente — exporte as variáveis no seu
shell (ou use um `.env.stress` + `dotenv-cli`, se preferir) antes de
rodar. Nada aqui é lido de `.env.local` do Next.

| Variável | Usada por | Como obter |
|---|---|---|
| `STRESS_TARGET_URL` | import, queue | Opcional — default `https://omnicrm.grupoddm.ia.br` |
| `STRESS_LOCAL_URL` | webhook | Opcional — default `http://localhost:3000` |
| `STRESS_SUPABASE_URL` | queue, webhook, report*, cleanup | URL do projeto Supabase (`mkrkkvbseobdqsalrorl`) |
| `STRESS_SERVICE_KEY` | queue, webhook, cleanup | Service role key do projeto Supabase (Settings → API) |
| `STRESS_SESSION_TOKEN` | import, queue | Cookie de sessão — ver abaixo |
| `STRESS_ACCOUNT_ID` | queue | Ver query SQL abaixo |
| `STRESS_USER_ID` | queue | Ver query SQL abaixo — **precisa ser o mesmo usuário do `STRESS_SESSION_TOKEN`** |
| `STRESS_META_APP_SECRET` | webhook | Precisa ser IGUAL ao `META_APP_SECRET` do `.env.local` do servidor que você vai testar (`npm run dev`) |
| `STRESS_WEBHOOK_PHONE_NUMBER_ID` | webhook (opcional) | Ver seção "Teste de webhook — Tier B" |

`report.ts` só lê arquivos já salvos em `tests/stress/results/`, não
precisa de nenhuma variável.

### Como obter `STRESS_SESSION_TOKEN`

1. Abra `https://omnicrm.grupoddm.ia.br` logado no navegador.
2. Abra o DevTools → aba **Application/Storage** → **Cookies** → selecione
   o domínio → copie o **valor** do cookie `sb-mkrkkvbseobdqsalrorl-auth-token`
   (começa com `base64-eyJ...`). Copiar da aba **Network** → header
   `Cookie:` também funciona, mas ali vem junto com outros cookies do
   domínio — pegar direto da aba de cookies evita ter que separar.
3. Não precisa montar `nome=valor` manualmente — `config.ts` detecta se
   falta o prefixo `sb-mkrkkvbseobdqsalrorl-auth-token=` e completa
   sozinho.

**Recomendado: grave num arquivo, não numa env var.** O cookie costuma
passar de 2000 caracteres — colar um valor desse tamanho numa variável de
ambiente (especialmente através de um agente que precisa retransmitir o
valor entre chamadas) arrisca truncar silenciosamente o final da string,
o que vira um 401 sem explicação óbvia. `config.ts` procura primeiro por
`tests/stress/.session-token` (já no `.gitignore`) antes de cair para a
env var:

```bash
# cole o valor do Cookie: direto no arquivo, sem passar por mais nenhum
# comando/ferramenta no meio do caminho
cat > tests/stress/.session-token <<'EOF'
cookie completo aqui
EOF
```

Alternativa (menos robusta para cookies muito longos, mas funciona):
```bash
export STRESS_SESSION_TOKEN="cookie completo aqui"
```

Esse cookie expira (a sessão do Supabase tem `expires_in: 3600`, 1 hora)
— se os testes começarem a voltar 401, gere um novo.

### Como obter `STRESS_ACCOUNT_ID` e `STRESS_USER_ID`

Rode no SQL Editor do Supabase (schema `wacrm`), autenticado como o mesmo
usuário do passo anterior:

```sql
select user_id, account_id
from wacrm.profiles
where user_id = auth.uid();
```

Se rodar isso fora do contexto do usuário (ex: como service role), troque
o filtro por algo que identifique a conta de teste, por exemplo:

```sql
select p.user_id, p.account_id
from wacrm.profiles p
join auth.users u on u.id = p.user_id
where u.email = 'seu-email-de-teste@exemplo.com';
```

`STRESS_USER_ID` precisa ser o dono do `STRESS_SESSION_TOKEN` porque
`POST /api/disparador/campaigns/[id]/start` rejeita com 403 quando
`campaign.created_by !== usuário da sessão`.

## Teste de import (Passo 2)

```bash
npm run stress:generate
npm run stress:import
```

Timeout de 120s por request. Para no primeiro tamanho que falhar
completamente (HTTP 5xx ou erro de transporte) — tamanhos maiores não
seriam informativos depois disso. Resultado em
`tests/stress/results/import-results.json`.

## Teste de fila (Passo 3)

```bash
npm run stress:queue
```

Cria uma campanha com `session_ids` apontando para um UUID que **não
existe** em `wacrm.whatsapp_config`. O cron real (rodando via crontab em
produção, batendo em `/api/disparador/cron` a cada minuto) reivindica os
itens normalmente e falha ao resolver o canal — cada item termina em
`status='erro'` sem nenhuma tentativa de envio de verdade (ver
`processQueue.ts:462`, `throw new Error("Canal não encontrado...")`).

Este script **não chama o cron diretamente** — ele só observa
`disp_message_queue` a cada 30s. Se a fila nunca sair de `agendado`, o
cron de produção provavelmente não está rodando ou está travado — isso
já é um resultado útil por si só.

Timeout de 10 minutos. Resultado em
`tests/stress/results/queue-results.json`.

**Nota sobre latência:** `disp_message_queue.updated_at` não é mantida
por trigger, e itens de erro não setam `sent_at`. O throughput reportado
é derivado da granularidade do polling (30s), não de timestamps exatos
no banco.

## Teste de webhook (Passo 4)

```bash
npm run stress:webhook
```

**Sempre roda contra `STRESS_LOCAL_URL` (default `localhost:3000`), nunca
contra produção** — suba o servidor local antes (`npm run dev`) com um
`.env.local` que aponte para o mesmo projeto Supabase de produção (ou
para uma cópia), e com `META_APP_SECRET` definido.

### Tier A — sempre roda

Usa um `phone_number_id` fictício que não corresponde a nenhum canal
salvo. A verificação de assinatura HMAC roda de ponta a ponta (cai no
fallback `process.env.META_APP_SECRET`), mas como nenhum
`wacrm.whatsapp_config` bate com o `phone_number_id`, a mensagem é
descartada antes de tocar em `contacts`/`conversations`/`messages`. Isso
mede a latência pura da camada HTTP + verificação de assinatura sob
10/50/100 requisições simultâneas — sem nenhum risco de escrever no
banco ou de qualquer efeito colateral (IA, automações).

### Tier B — opcional, requer canal de teste real

Para testar o pipeline completo (contato/conversa/mensagem sendo
criados de verdade, e o `UNIQUE` de `messages.message_id` segurando
redelivery — migration 088), você precisa de um canal de teste real em
`wacrm.whatsapp_config`.

**Este script nunca cria esse canal sozinho.** O schema ao vivo dessa
tabela diverge dos arquivos de migration neste repo (colunas como
`provider`, `habilitado`, `app_secret` foram adicionadas em migrations
que nem sempre batem 1:1 com o que está rodando) — inserir uma linha
"no escuro" numa tabela de produção que roteia webhooks reais é um risco
desnecessário. Confira o schema ao vivo primeiro:

```sql
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'wacrm' and table_name = 'whatsapp_config'
order by ordinal_position;
```

Depois insira um canal de teste adaptando ao que a query acima mostrar.
Pontos importantes de segurança:

- **`access_token` precisa ser um valor gerado com a MESMA função
  `encrypt()` do app** (`src/lib/whatsapp/encryption.ts`), usando o
  `ENCRYPTION_KEY` real — senão `decrypt()` lança exceção e derruba o
  processamento de toda a mensagem antes mesmo de chegar no teste.
  Gere com Node usando esse mesmo `ENCRYPTION_KEY`:
  ```js
  node -e "process.env.ENCRYPTION_KEY='<sua chave>'; console.log(require('./src/lib/whatsapp/encryption.ts'))" // ajuste para rodar via tsx
  ```
  Ou mais simples, crie um script de uma linha com tsx:
  ```bash
  ENCRYPTION_KEY=<sua-chave> npx tsx -e "import {encrypt} from './src/lib/whatsapp/encryption'; console.log(encrypt('STRESS_TEST_FAKE_TOKEN'))"
  ```
  **Use um valor de token obviamente inválido** (ex: `STRESS_TEST_FAKE_TOKEN`)
  — mesmo que algo tente enviar uma resposta automática de IA usando esse
  canal, a chamada à Meta falha na autenticação antes de qualquer
  mensagem real sair.
- **Deixe `app_secret` NULL** — o webhook cai de volta para
  `process.env.META_APP_SECRET` (o mesmo `STRESS_META_APP_SECRET` que
  você já configurou), evitando ter que encriptar mais um valor.
- **Desative IA / auto-resposta para a conta de teste antes de rodar
  Tier B**, mesmo com o token inválido — defesa em profundidade.
- Use um `phone_number_id` e `display_phone_number` prefixados
  `STRESS_TEST` (ex: `STRESS_TEST_9999999999`) — `cleanup.ts` procura por
  esse prefixo para apagar o canal depois.
- Se a coluna `habilitado` existir, deixe `false` — mantém o canal fora
  de qualquer fluxo de envio de campanha real.

Com o canal criado, exporte o `phone_number_id` usado:

```bash
export STRESS_WEBHOOK_PHONE_NUMBER_ID="STRESS_TEST_9999999999"
```

e rode `npm run stress:webhook` novamente — o Tier B roda automaticamente
quando essa variável está presente.

## Relatório (Passo 5)

```bash
npm run stress:report
```

Lê tudo que existir em `tests/stress/results/*.json` e imprime um resumo
no terminal, além de salvar `report_<timestamp>.json` com os dados
completos.

## Limpeza (Passo 6)

```bash
npm run stress:cleanup
```

Remove, nessa ordem: `disp_message_queue` das campanhas `STRESS_TEST%` →
`campaign_metrics` → `campaigns` → contatos (por tag `STRESS_TEST` OU
nome prefixado — cobre tanto os importados via CSV quanto os criados
pelo teste de webhook) → a tag `STRESS_TEST` (se não estiver mais em uso)
→ qualquer canal de teste (`whatsapp_config`) prefixado `STRESS_TEST`.
Contatos e campanhas com FK `ON DELETE CASCADE` levam junto
`conversations`, `messages`, `contact_tags`, `contact_phones` e
`contact_import_variables` relacionados.

Imprime contagens antes/depois de cada categoria. Rode de novo se algo
não tiver sido removido — o script é idempotente (contagem zero não
gera erro).

## Restrições que este design respeita

- Nenhum dado real de CPF/telefone é usado — telefones são gerados no
  DDD 99 com um padrão sequencial (`generate-csv.ts`).
- Nenhum envio de WhatsApp real acontece: a campanha de teste
  (`test-queue.ts`) usa um `session_id` que não existe, então todo item
  falha antes de chegar em qualquer API de envio; o teste de webhook só
  simula mensagens *recebidas*, e o Tier B (quando usado) usa um
  `access_token` deliberadamente inválido.
- Tudo é prefixado `STRESS_TEST` para `cleanup.ts` conseguir achar e
  remover.

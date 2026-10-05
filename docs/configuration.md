# Configuração

A referência operacional é [`.env.local.example`](../.env.local.example). Este documento organiza as variáveis por responsabilidade.

## Regras

- nunca use prefixo `NEXT_PUBLIC_` para segredos;
- service role, tokens de provider e segredos de webhook existem apenas no servidor;
- produção deve guardar segredos no painel/runtime, não em arquivo versionado;
- rotacionar `ENCRYPTION_KEY` sem plano de migração invalida dados criptografados com a chave anterior.

## Núcleo da aplicação

| Variável | Obrigatória | Uso |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | sim | URL do projeto Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | sim | chave pública para cliente/SSR |
| `SUPABASE_SERVICE_ROLE_KEY` | sim | operações server-side privilegiadas |
| `ENCRYPTION_KEY` | sim | AES-256-GCM para segredos persistidos |
| `NEXT_PUBLIC_SITE_URL` | recomendada | URL canônica do CRM |
| `NEXT_PUBLIC_APP_URL` | recomendada em omnichannel | redirects e links públicos |

`ENCRYPTION_KEY` deve ter 32 bytes representados por 64 caracteres hexadecimais.

## Meta / WhatsApp / Social

| Variável | Quando usar |
| --- | --- |
| `META_APP_SECRET` | verificação de webhook e integrações Meta |
| `META_APP_ID` | templates com upload e recursos de app Meta |
| `META_WEBHOOK_VERIFY_TOKEN` | webhook de Instagram/Messenger |
| `META_GRAPH_VERSION` | override da versão Graph |
| `INSTAGRAM_APP_ID` | Instagram Login |
| `INSTAGRAM_APP_SECRET` | Instagram Login |
| `WAHA_WEBHOOK_SECRET` | autenticação de webhooks WAHA |

Tokens de linha/WABA configuráveis pela UI são persistidos de forma protegida; não os replique em documentação.

## IA

O CRM aceita provider por conta. Chaves master podem ser fornecidas por ambiente:

```env
OPENAI_API_KEY=
GEMINI_API_KEY=
CLAUDE_API_KEY=
ANTHROPIC_API_KEY=
OPENROUTER_API_KEY=
DISPARADOR_OPENAI_API_KEY=
```

`DISPARADOR_OPENAI_API_KEY` separa consumo do disparador; quando ausente, o código pode usar `OPENAI_API_KEY` como fallback.

## DDM Acordos

```env
DDM_ACORDOS_API_TOKEN=
```

Usado para consultas e formalização no fluxo de cobrança. Os aliases legados `DDM_TOKEN` e `DDM_API_KEY` ainda são aceitos em partes do código, mas `DDM_ACORDOS_API_TOKEN` é o nome preferido.

## Disparador e UTM

```env
UTM_API_KEY=
DISPATCH_SINGLE_ACCOUNT_ID=
```

`UTM_API_KEY` autentica chamadas server-side ao serviço de UTM. `DISPATCH_SINGLE_ACCOUNT_ID` existe para cenários legados/auxiliares e não deve ser usado como substituto de account scoping normal.

## Crons e health checks

```env
AUTOMATION_CRON_SECRET=
STRESS_RUN_SECRET=
STRESS_API_KEY=
```

Todo endpoint de cron exposto publicamente deve usar segredo forte, diferente de outras credenciais.

## Auditoria

```env
AUDIT_HEADER_SECRET=
DDM_LOGS_USER=
DDM_LOGS_PASSWORD=
```

`AUDIT_HEADER_SECRET` assina contexto de auditoria em escritas SSR. As credenciais de logs são suporte administrativo e não substituem autorização account-scoped.

## VoIP

```env
VOIP_URL=http://127.0.0.1:8080
VOIP_SERVICE_SECRET=
```

O mesmo segredo deve estar configurado no serviço Go.

## Desenvolvimento e testes

```env
WHATSAPP_TEMPLATES_DRY_RUN=true
```

Use dry-run apenas fora de produção.

## Checklist de produção

Antes do deploy:

- [ ] Supabase URL/anon/service role apontam para o mesmo projeto.
- [ ] `ENCRYPTION_KEY` está definida e preservada.
- [ ] segredos de webhook estão sincronizados com os provedores.
- [ ] chaves de IA necessárias estão presentes.
- [ ] `DDM_ACORDOS_API_TOKEN` existe se a cobrança por IA estiver ativa.
- [ ] segredos de cron são aleatórios e exclusivos.
- [ ] `npm run schema:check` passa.
- [ ] nenhuma credencial está em arquivos versionados.

# Operações e deploy

## Runtime principal

O CRM principal roda como aplicação Node/Next.js. O deploy atual versionado em `.cpanel.yml` usa Node `20.19.0`, executa verificação de schema, build e reinicia o processo via arquivo `tmp/restart.txt`.

```bash
nvm use 20.19.0
npm install --no-audit --no-fund
npm run schema:check
npm run build
touch tmp/restart.txt
```

## Regra para jobs recorrentes

Não use timers em memória como mecanismo de confiabilidade. O processo pode reiniciar a qualquer momento.

Use:

- endpoint cron stateless;
- estado no banco;
- lock/lease persistido quando houver risco de sobreposição;
- idempotência para efeitos externos.

## Crons relevantes

O repositório contém, entre outros:

- `/api/automations/cron`
- `/api/disparador/cron`
- `/api/flows/cron`
- retry de assignment de conversas

Proteja endpoints de cron com segredo quando o contrato exigir.

## CI

`.github/workflows/ci.yml` executa:

1. lint;
2. typecheck;
3. testes;
4. build da aplicação principal;
5. build do backend auxiliar do disparador;
6. build do frontend auxiliar do disparador;
7. testes e build do serviço VoIP.

PR sem CI verde não deve ser mergeado, salvo procedimento explícito de incidente.

## Observabilidade

Fontes importantes:

- `wacrm.system_logs`;
- `flow_runs` e `flow_run_events`;
- logs de auditoria;
- estado da fila do disparador;
- página administrativa `/ddm-logs`;
- monitoramento e relatórios no dashboard;
- logs do runtime/Passenger;
- status do provedor externo.

## Health checks

O endpoint de stress/health usa `STRESS_RUN_SECRET` e pode validar múltiplas dependências. Ele deve ser tratado como ferramenta operacional, não como substituto para observabilidade contínua.

## Deploy seguro

Antes:

- [ ] CI verde;
- [ ] migration necessária aplicada/validada;
- [ ] `schema:check` passa no destino;
- [ ] variáveis novas configuradas;
- [ ] plano de rollback definido;
- [ ] mudanças de provider testadas em conta controlada.

Depois:

- [ ] login;
- [ ] carregamento da Inbox;
- [ ] recebimento de mensagem;
- [ ] envio de mensagem;
- [ ] flow básico;
- [ ] cron crítico;
- [ ] logs sem erro novo recorrente.

## Rollback

Código:

1. identifique commit estável;
2. reverta/retorne branch;
3. rode `schema:check`;
4. faça build;
5. reinicie processo.

Banco:

- migrations destrutivas exigem plano específico;
- não reverta schema automaticamente sem avaliar dados escritos pela versão nova;
- prefira forward-fix quando rollback de banco puder causar perda.

## Incidentes

Durante incidente:

1. preservar evidências;
2. identificar escopo por conta/canal/período;
3. interromper efeitos perigosos (campanha, cron, integração) sem apagar dados;
4. localizar primeiro erro causal, não o último sintoma;
5. corrigir;
6. reconciliar filas/runs pendentes;
7. documentar causa raiz e prevenção.

Veja [troubleshooting.md](./troubleshooting.md).

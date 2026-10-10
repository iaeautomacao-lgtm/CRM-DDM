# Testes e qualidade

## CI

Quatro jobs:

1. app principal: lint, typecheck, test, build;
2. Disparador backend build;
3. Disparador frontend build;
4. VoIP go test + build.

## Inventário

122 arquivos de teste/spec no baseline.

Cobertura inclui auth, roles, API keys, webhooks, flows, AI tools/recovery, heartbeat, anti-loop, prompts, sentimento, tabulação, Disparador, SQL reliability, channels, conversations e utilitários de UI.

## Gate local

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

Banco: adicionar schema check e validação SQL.

VoIP: `go test ./...`.

## Regra de regressão

Bugs em concorrência, retries, RLS, audience, exit tags, model/provider, handoff e assignment devem ganhar teste sempre que possível.

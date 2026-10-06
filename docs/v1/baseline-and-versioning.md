# Baseline e versionamento

## Definição de V1

V1/V2 é uma classificação de produto. Não deve ser inferida de `package.json.version`.

Baseline V1:

```text
ff2ab0d75676707426beb5c9c144f2ff25b92a23
chore(disparador): limitar cron batch a 700 (#69)
```

## Critério de inclusão

Entra na V1:

- tudo mergeado em `main` até o baseline;
- migrations necessárias ao runtime já incorporado;
- comportamento live compatível com o código.

Não entra:

- PR aberto;
- branch experimental;
- migration preparada somente em branch;
- comportamento apenas descrito em PRD.

## V2 já iniciada

PRs V2 abertos no congelamento:

| PR | Tema |
| --- | --- |
| #57 | acessibilidade |
| #60 | simulador de flows |
| #62 | robustez adicional do Disparador |
| #63 | Intelligence: origin + MCP resources |
| #70 | simplificação do painel do contato |
| #71 | tabulação sugerida pela IA |

Esses PRs não são fonte de verdade da V1.

## Importante

PRs mergeados como #50–#56 e #61–#69 pertencem à V1. Termos como “Fase 2” dentro de um PRD não significam automaticamente “produto V2”.

## Política recomendada

- `docs/v1/**`: congelado; corrigir apenas erro factual;
- `docs/v2/**`: documentação evolutiva;
- futuras mudanças V2 não devem alterar retrospectivamente o comportamento descrito para V1;
- quando V2 estabilizar, criar novo baseline por commit/tag.

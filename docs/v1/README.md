# CRM DDM — Documentação Técnica da V1

Esta pasta congela a documentação técnica da **V1 do CRM DDM**.

Baseline adotado:

- commit: `ff2ab0d75676707426beb5c9c144f2ff25b92a23`
- data: 06/10/2026
- último PR incluído no baseline: #69
- `package.json.version`: `0.2.2` — versão de pacote, não nomenclatura de produto.

A regra é objetiva: **V1 = o que está na `main` neste baseline**. PRs abertos de V2 não entram nesta documentação.

## Escopo funcional

A V1 inclui:

- Next.js + React + TypeScript;
- Supabase Auth/Postgres/Storage/Realtime;
- Inbox omnichannel;
- Meta WhatsApp, WAHA, Instagram, Messenger e Webchat;
- contatos, usuários, equipes, papéis e tabulações;
- Flow Builder + engine persistente;
- agente de IA com tools, handoff, recovery, heartbeat e telemetria;
- seleção de modelo por nó dentro do provider da conta;
- Disparador com importação, audience, fila, batch, retry, blacklist, receipts e UTM;
- automações;
- DDM Intelligence;
- API pública e MCP;
- monitoramento, relatórios, auditoria e health/stress;
- serviço VoIP auxiliar.

## Inventário do baseline

| Item | Quantidade |
| --- | ---: |
| Arquivos versionados | 1.217 |
| Páginas de dashboard | 40 |
| Route Handlers | 111 |
| Arquivos de migration | 159 |
| Arquivos de teste/spec | 122 |
| Arquivos em `src/lib` | 320 |
| Tabelas live em `wacrm` | 75 |

## Índice

1. [Baseline e versionamento](./baseline-and-versioning.md)
2. [Arquitetura](./architecture.md)
3. [Módulos](./application-modules.md)
4. [Flow Engine](./flow-engine.md)
5. [IA e agentes](./ai.md)
6. [Canais, Inbox e roteamento](./channels-and-inbox.md)
7. [Disparador](./disparador.md)
8. [Banco de dados](./database.md)
9. [APIs e integrações](./api-and-integrations.md)
10. [Segurança e acesso](./security-and-access.md)
11. [Observabilidade e operação](./observability-and-operations.md)
12. [Testes e qualidade](./testing-and-quality.md)
13. [Limitações conhecidas](./known-limitations.md)

A evolução posterior está separada em [../v2/README.md](../v2/README.md).

## Fontes de verdade

Esta documentação foi derivada de:

1. código da `main` no baseline;
2. migrations versionadas;
3. schema live do Supabase;
4. histórico de PRs.

Em divergências, o runtime atual define comportamento e o schema live define estrutura realmente existente.

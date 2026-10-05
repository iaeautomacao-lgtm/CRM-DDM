# Documentação do CRM DDM

Este diretório é o ponto de entrada para arquitetura, desenvolvimento, operação e integrações do CRM DDM.

## Mapa da documentação

| Documento | Use quando precisar de |
| --- | --- |
| [Getting started](./getting-started.md) | preparar ambiente local ou um novo deployment |
| [Arquitetura](./architecture.md) | entender módulos, dependências e fluxo de dados |
| [Configuração](./configuration.md) | configurar variáveis de ambiente e segredos |
| [Banco de dados](./database.md) | trabalhar com Supabase, schema `wacrm` e migrations |
| [Integrações](./integrations.md) | entender Meta, WAHA, IA, DDM Acordos, UTMPay, Social e VoIP |
| [Operações](./operations.md) | deploy, crons, health checks, observabilidade e rollback |
| [Troubleshooting](./troubleshooting.md) | investigar falhas comuns de mensagens, IA, flows e filas |
| [API pública](./public-api.md) | integrar sistemas externos via `/api/v1` |
| [VoIP](../voip/README.md) | trabalhar no serviço de voz em Go |
| [Disparador auxiliar](../disparador/README.md) | trabalhar nos serviços auxiliares do disparador |

## Princípios de documentação

A documentação deve refletir o comportamento do código atual. Ao alterar runtime, configuração, banco ou contrato externo:

1. atualize o código;
2. atualize o documento correspondente;
3. inclua a mudança no PR;
4. evite documentar segredos, tokens reais, CPFs ou dados de produção.

O schema live pode divergir de migrations antigas. Para banco, trate a combinação **schema de produção + migrations versionadas + `schema:check`** como fonte operacional de verdade.

## Onde procurar no código

- UI e páginas: `src/app/(dashboard)`
- APIs e webhooks: `src/app/api`
- fluxo visual: `src/lib/flows`
- IA: `src/lib/ai`
- disparos: `src/lib/disparador`
- WhatsApp: `src/lib/whatsapp`
- inteligência/relatórios: `src/lib/intelligence` e `src/lib/relatorios`
- Webchat: `src/lib/webchat`
- schema: `supabase/migrations`

Para regras de contribuição, consulte [../CONTRIBUTING.md](../CONTRIBUTING.md).

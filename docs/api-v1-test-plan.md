# Testes da API pública V1 (12 operações)

Esta validação cobre a API pública do CRM DDM, em **main**. Não inclui as centenas de rotas internas do dashboard.

## Execução automática
- \`src/app/api/v1/public-api-matrix.test.ts\`: executa os **12 handlers reais** sem chave (401), com escopo insuficiente (403), confirma o escopo solicitado, garante ausência de leitura em requisições bloqueadas, valida o contrato público OpenAPI e testa retornos 200 com banco sintético nas rotas de leitura.
- Acrescenta `src/app/api/v1/disparador/campaigns/status-route.test.ts`: valida consulta 200/404, retorno das métricas e impedimento de acesso a campanhas de outra conta.
- Continua usando as suites existentes: \`openapi.test.ts\`, \`api-context.test.ts\`, \`extract.test.ts\`, \`extract.sql.test.ts\` (PostgreSQL PGlite), \`extract-routes.test.ts\`, \`reporting.test.ts\`, \`disparador/campaigns/route.test.ts\`, \`whatsapp/send/route.test.ts\`.
- Executar pelo CI (\`npm run lint\`, \`npm run typecheck\`, \`npm test\`, \`npm run build\`); **nenhum teste envia mensagem real**.

## Smoke autenticado depois do deploy
\`API_SMOKE_BASE_URL=https://omnicrm.grupoddm.ia.br API_SMOKE_KEY=*** node scripts/smoke-public-api-v1.mjs\`

A chave deve ser fornecida por variável de ambiente (nunca commitar), com os escopos \`reports:read\`, \`conversations:read\`, \`messages:read\` e opcionalmente \`campaigns:read\`. O script:
- chama o OpenAPI público;
- verifica **401 em todas as 12 operações** sem chave, inclusive os dois POST (nenhum envio);
- identifica a conta e escopos da chave em \`/me\`;
- consulta as cinco rotas de relatórios, lista de conversas e extração de mensagens por período;
- quando houver conversa, lê um item do histórico individual;
- só testa consulta de campanha com \`API_SMOKE_CAMPAIGN_ID\`.

O script informa apenas HTTP e códigos de erro; nunca mostra conteúdo, telefone ou credenciais.

## Condições para liberação em produção
1. Aplicar \`330_api_v1_conversation_extract.sql\` e confirmar \`messages.origin\`, \`api_v1_messages\`, \`api_v1_conversation_message_counts\`.
2. Publicar versão da \`main\` com PR #433 incluída.
3. Executar smoke do próprio servidor com chave de teste restrita, sem disparar mensagens.
4. Confirmar HTTP 200 e cursor na API de extração, e isolamento de contas.
5. Teste POST de sucesso requer ambiente de homologação e números de teste autorizados; nunca executar sem aprovação em produção.

**Limitação:** sem conectividade ao domínio e sem chave de API disponível neste executor, não é possível certificar o comportamento autenticado da implantação em produção. O teste CI com banco simulado não equivale a E2E da produção.

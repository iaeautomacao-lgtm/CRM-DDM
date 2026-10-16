# Meta onboarding / Fortics -> OmniDDM (V1)

## Status
Primeira entrega: descoberta e pré-cadastro **somente leitura na Meta**, sem
ativação ou transferência de números. Destino: PR para \`main\`, com
\`379_meta_onboarding_foundation.sql\`. O sistema existente de envio/recebimento
não é alterado.

## O que foi implementado
- Em **Canais > Integrações Meta**, somente administradores:
  - cadastrar integração centralizada com Business Portfolio ID + token de
    sistema ou reutilizar token de canal da mesma organização;
  - opcionalmente informar App ID e App Secret;
  - descobrir WABAs próprias/compartilhadas e números autorizados via Graph;
  - detectar se número já está cadastrado em outro canal do CRM (sem revelar
    dados de outras organizações);
  - confirmar ciência do processo e preparar rascunho com origem
    Fortics/outro/novo, sem chamar \`/register\`;
  - ver rascunhos e canais atuais (status local, não prova de ativação).
- Tokens e App Secrets cifrados em repouso com a chave \`ENCRYPTION_KEY\` já
  usada pela V1, jamais enviados nos GETs.
- \`meta_onboarding_integrations\`, \`meta_onboarding_drafts\`,
  \`meta_onboarding_events\`: tabelas privadas sem policies para browser,
  \`service_role\` apenas; FKs compostas garantem escopo de conta.
- Graph discovery só faz GETs construídos no servidor, URLs e IDs
  validados, no máximo 4 páginas por recurso, timeout de 12s e limite
  de 20 WABAs/200 números.
- GET/POST exigem conta autenticada + papel admin/owner.

## Dependências Meta
- Token de sistema concedido aos ativos do Business Portfolio.
- Permissões da Meta (em especial \`whatsapp_business_management\`, e
  \`business_management\` quando a enumeração empresarial exigir).
- Business Portfolio ID correto; o cadastro pode reutilizar o token
  já armazenado em um canal autorizado da mesma organização.
- Para implantação de Embedded Signup v4 ainda será necessário
  validar o aplicativo Meta e sua configuração \`config_id\`/permissões
  aprovadas. Este PR não oferece OAuth/Embedded Signup nem troca de BSP.

## Deploy seguro
1. Executar o pré-check da migration 379 no Supabase V1
   \`cyftbffhgjmsfogxawrl\`; confirmar não colisão na V2.
2. Aplicar \`379_meta_onboarding_foundation.sql\` **antes** de publicar o
   frontend/rotas (não toca \`whatsapp_config\` nem executa Meta).
3. Aguardar CI, revisar PR, fazer merge em \`main\` e deploy da V1.
4. Com admin, cadastrar integração piloto usando token autorizado; consultar
   números e verificar o status de um deles.
5. Criar um rascunho piloto; assegurar que o número não saiu da Fortics,
   que o webhook/IA da V1 não mudou e que não houve disparo.
6. Antes da **etapa seguinte (ativação)** confirmar: titularidade do Business,
   elegibilidade WAME/WAAC/PMA, roteamento de conversas, templates,
   aprovações da Meta e plano de rollback.

## Proteções
- Nunca mostrar token/App Secret no navegador depois de criar.
- Não armazenar segredo em storage/browser nem registrar payloads com
  token em log de auditoria.
- Integrações/drafts sempre filtradas por \`account_id\` vindo da sessão.
- Nenhum POST para Meta é permitido nesta fase.
- Em descoberta parcial, exibir avisos e não marcar canal como ativo.
- Versão configurável \`META_ONBOARDING_GRAPH_VERSION\`: aceita apenas
  \`v25.0\` e \`v26.0\`, padrão \`v26.0\`. Não altera v21.0 usado pelo envio V1.

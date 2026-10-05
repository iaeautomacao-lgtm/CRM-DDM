# Política de segurança

O CRM DDM processa conversas, dados cadastrais e integrações com provedores externos. Vulnerabilidades devem ser tratadas de forma privada.

## Reporte

**Não abra issue pública para vulnerabilidades, segredos expostos ou acesso indevido a dados.**

Use um canal privado da equipe responsável pelo repositório ou o mecanismo de Security Advisories do GitHub quando disponível.

Inclua:

- impacto;
- passos de reprodução;
- componente afetado;
- commit/ambiente;
- evidências mínimas necessárias;
- mitigação conhecida, se houver.

Não inclua mais dados de clientes que o necessário para reproduzir.

## Escopo prioritário

- autenticação e autorização;
- RLS e account scoping;
- service role;
- webhooks Meta/WAHA/Social;
- criptografia de credenciais;
- API keys;
- uploads e URLs assinadas;
- execução de tools pela IA;
- crons públicos;
- VoIP service secret;
- logs/auditoria com dados sensíveis.

## Segredos

Segredos nunca devem ser:

- commitados;
- enviados ao browser;
- gravados em logs;
- incluídos em screenshots públicos;
- persistidos em config de flow quando existe armazenamento seguro dedicado.

Se um segredo vazar, considere-o comprometido e rotacione-o.

## Dados pessoais

Ao investigar incidentes:

- prefira IDs internos;
- masque CPF, telefone e e-mail;
- não copie payloads completos para issues;
- limite acesso às evidências.

## Dependências

Falhas em Next.js, Supabase, Node, bibliotecas ou providers externos devem ser avaliadas quanto ao impacto no CRM e corrigidas por upgrade/configuração quando aplicável.

## Resposta a incidente

1. conter o problema;
2. preservar logs/evidências;
3. identificar contas e período afetados;
4. rotacionar credenciais se necessário;
5. aplicar correção;
6. reconciliar ações pendentes;
7. documentar causa raiz e prevenção.

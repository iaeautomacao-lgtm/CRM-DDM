# Segurança e controle de acesso

## Papéis

```text
owner > admin > supervisor > agent > viewer
```

Ranks: 5, 4, 3, 2, 1.

## Capacidades

Owner: administração completa, ownership e destrutivos.

Admin: membros, settings, canais, templates, flows e administração.

Supervisor: operação + monitoramento/intelligence das equipes, sem administração da conta.

Agent: atendimento e escrita operacional no escopo permitido.

Viewer: leitura.

## Camadas

1. UI
2. guard de rota
3. helpers de role
4. sessão
5. RLS
6. validação antes de service role

## Service role

Nunca no browser. Qualquer rota que a use precisa validar conta/permissão.

## Segredos

A V1 já impede gravação client-side direta de segredos sensíveis de `whatsapp_config`.

`ENCRYPTION_KEY` protege valores persistidos conforme a implementação.

## Webhooks

Meta usa `META_APP_SECRET`; WAHA usa `WAHA_WEBHOOK_SECRET`; Social usa verify/app credentials.

## API keys

Persistidas como hash. `intelligence:read` é chave pessoal.

## PII

CPF, telefone, e-mail, conversa e negociação exigem mascaramento em logs/issues.

## Ameaças principais

- BOLA entre contas;
- vazamento de service role;
- segredo inline em tool;
- webhook forjado;
- duplicação/replay;
- logs com PII;
- credencial no histórico Git.

# API interna de permissões (para o front)

Rotas **internas** (sessão do usuário; não fazem parte da API pública `/api/v1` nem do OpenAPI).
Fonte: PRD 20 (seção 8, fase 20.10). O front só consome: nenhum controle deve decidir por `account_role`,
e sim por `permissions`, `scopes` e `pages`. Resposta sempre com `Cache-Control: no-store`.

Erros usam o formato atual do app: `{ "error": "mensagem" }` com **401** (sem sessão) ou **403**.
(O formato `{error:{code,…}}` do PRD será adotado junto da fase 20.3, quando `requirePermission` existir.)

## `GET /api/me/permissions`

Qualquer membro autenticado. Derivado de `getCurrentAccount().permissions`: não decide nada novo.

```jsonc
{
  "organization": { "id": "…", "name": "Acme" },
  "role": { "id": null, "key": "agent", "name": "Operador", "kind": "system", "rank": 2 },
  "permissions": ["inbox.view", "inbox.reply", "…"],          // ordem do catálogo
  "scopes": { "inbox": "own", "monitoring": "none", "reports": "none", "intelligence": "none" },
  "pages": ["/inbox"],                                          // páginas com gate que o papel acessa
  "status": "active"
}
```

- `role.id` é `null` enquanto só existem papéis de sistema (a linha em `account_roles` ainda não é lida aqui);
  `role.key` é sempre um dos 5 papéis de sistema (o "compat" quando houver papel personalizado).
  `rank`: owner 5 · admin 4 · supervisor 3 · agent 2 · viewer 1.
- `scopes`: `all` | `team` | `own` | `none`. `inbox` nunca é `none` (sem escopo amplo nem de equipe = `own`,
  as dele + fila da equipe). `monitoring`, `reports` e `intelligence` são `none` quando o papel não tem a área.
  (O visualizador tem `inbox: "all"` hoje — comportamento preservado, P-06 do PRD 20.)
- `pages`: prefixos de `ROUTE_ALLOWLIST` (`src/lib/role-utils.ts`) liberados ao papel; substitui a tabela duplicada no front.
  Rotas sem gate (não listadas ali) continuam livres.

## `GET /api/account/permission-catalog`

Permissão: `roles.manage` **ou** `members.view` (hoje todos os papéis têm `members.view`). Somente leitura.

```jsonc
{
  "groups": [
    {
      "key": "inbox", "label": "Inbox",
      "permissions": [
        { "key": "inbox.reply", "label": "Responder", "description": "…",
          "scope": "n/a",              // account | team | own | n/a
          "ownerOnly": false,          // true = nunca entra em papel personalizado (mostrar desabilitada)
          "grantable": true,
          "dependsOn": ["inbox.view"] }
      ]
    }
  ]
}
```

Grupos na ordem do catálogo; `key` do grupo sem acento (`fluxos-e-ia`, `organizacao`). O catálogo é o mesmo de
`src/lib/auth/permissions.ts` e da tabela `wacrm.permission_catalog` (migration 240).

## Testes e matriz dourada

`src/lib/auth/me-permissions.test.ts` (conteúdo por papel e escopos), `src/app/api/me/permissions/route.test.ts`
(rotas) e a matriz `src/lib/auth/permissions-matrix.ts` (as duas rotas constam como `session`).

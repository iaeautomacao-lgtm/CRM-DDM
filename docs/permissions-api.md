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

- Papel de sistema: `role.id` é `null` e `kind` é `"system"`. Papel personalizado (migrations 312/313): `role.id` é o id
  em `account_roles`, `kind` é `"custom"` e `name` é o nome dado pelo proprietário; `permissions` e `scopes` saem do conjunto
  do papel. `role.key` é sempre um dos 5 papéis de sistema (no personalizado, o compat_role — o que o RLS e `pages` usam).
  `rank`: owner 5 · admin 4 · supervisor 3 · agent 2 · viewer 1 (no personalizado, o do compat).
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
          "ownerOnly": false,          // true = só o proprietário
          "grantable": true,           // false = não entra em papel personalizado (ownerOnly ou ainda sem uso no código): desabilitar
          "dependsOn": ["inbox.view"] }
      ]
    }
  ]
}
```

Grupos na ordem do catálogo; `key` do grupo sem acento (`fluxos-e-ia`, `organizacao`). O catálogo é o mesmo de
`src/lib/auth/permissions.ts` e da tabela `wacrm.permission_catalog` (migration 240).

## Papel personalizado (migrations 312/313)

Só o **proprietário** cria, edita, apaga e atribui (`roles.manage`). Até 20 por organização. Nenhuma permissão com
`grantable: false` entra; dependências (`dependsOn`) têm de estar marcadas (o servidor não completa sozinho; a variante
ampla cobre a estreita, ex.: `reports.view_all` cobre `reports.view_team`).

| Rota | Permissão | Corpo → resposta |
|---|---|---|
| `GET /api/account/roles` | `members.view` | → `{ roles: RoleView[], limits: { max_custom_roles, custom_roles } }` |
| `POST /api/account/roles` | `roles.manage` | `{ name, description?, permissions[] }` → 201 `{ ok, id, key, compat_role }` |
| `PATCH /api/account/roles/{id}` | `roles.manage` | `{ name?, description? (null limpa), permissions? }` → `{ ok, id, compat_role, previous_compat_role, members_updated }` |
| `DELETE /api/account/roles/{id}` | `roles.manage` | → `{ ok, id, name }` |
| `PUT /api/account/members/{userId}/role` | `roles.manage` | `{ role_id }` (personalizado ou de sistema, menos proprietário) → `{ ok, previous_role_id, role_id, compat_role }` |

`RoleView`: `{ id, key, name, description, kind: "system"|"custom", rank, compat_role, permissions[], member_count,
member_ids[], created_at, updated_at }` — sistema primeiro (rank desc), depois personalizados por nome.

Erros: `{ error, code, ... }` — 400 `invalid` | `invalid_permissions` (+ `errors: [{code: unknown_permission|owner_only|
not_grantable|missing_dependency, permission, requires?}]`) · 403 `forbidden` (não é o proprietário; o próprio papel; o
proprietário como alvo) · 404 `not_found` · 409 `name_taken` | `limit_reached` | `role_in_use` (+ `members`) · 503 `unavailable`
(migrations não aplicadas). O `PATCH /api/account/members/{userId}` (admin, papéis de sistema) responde 403 quando o membro
tem papel personalizado e quem pede não é o proprietário.

**Acesso direto aos dados (aviso do editor):** nesta entrega o RLS das leituras feitas direto do navegador segue o
`compat_role` (menor papel de sistema que contém todas as permissões do personalizado) — pode ler mais do que o papel
permite. Ex.: papel só com leituras cai em compat Visualizador, que lê todas as conversas. As ações e as rotas `/api`
seguem o papel à risca. Mostrar no editor: "No acesso aos dados, este papel equivale a <compat>".

## Testes e matriz dourada

`src/lib/auth/me-permissions.test.ts` (conteúdo por papel e escopos), `src/app/api/me/permissions/route.test.ts`
(rotas) e a matriz `src/lib/auth/permissions-matrix.ts` (as duas rotas constam como `session`).

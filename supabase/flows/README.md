# Fluxos versionados

Na raiz do projeto, configure `NEXT_PUBLIC_SUPABASE_URL` e
`SUPABASE_SERVICE_ROLE_KEY` no ambiente ou em `.env.local` (também são lidos
`.env.production.local`, `.env.production` e `.env`, nessa ordem, sem substituir
variáveis já definidas). A chave service role deve ficar somente no ambiente local/servidor.

```sh
node scripts/export-flow.mjs <flow_id> --out supabase/flows/<slug>.json
```

Sem `--out`, o JSON vai para stdout. O destino deve estar dentro do projeto.
O export inclui a definição e as posições dos nós, ordenados por `node_key`,
com chaves ordenadas, indentação de dois espaços e newline final. Timestamps,
contadores e identificadores de conta/usuário ficam fora do arquivo.

Tokens em campos sensíveis, URLs e headers são mascarados com `***`;
referências `{{secret.NOME}}` são preservadas, sem resolver o segredo.
Revise o JSON antes de versionar: texto livre pode conter credenciais sem um
formato reconhecível. Exportar durante uma edição pode produzir uma leitura
inconsistente; prefira um fluxo sem alterações simultâneas. O script só lê o banco.

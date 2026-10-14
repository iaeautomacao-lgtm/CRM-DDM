# Teste automático das telas (E2E)

Um robô (Playwright) abre as telas principais com cada papel (proprietário, admin, supervisor e operador) e **falha** se:

- uma tela quebra: erro de JavaScript no console, tela de erro, 404/500 ou página em branco;
- um papel vê uma tela que não devia (o certo é cair em `/unauthorized`) ou **não** vê uma que devia;
- o menu lateral mostra um link que o papel não pode abrir, ou omite um que deveria mostrar;
- `GET /api/me/permissions` (campo `pages`) diverge de `ROUTE_ALLOWLIST`.

**Somente leitura.** O robô só navega. Qualquer requisição que não seja GET ao app é bloqueada pelo próprio teste e aparece
no relatório como "escrita bloqueada" (rede de segurança, caso uma tela grave algo ao abrir).

## De onde vêm as telas e as regras

Nada é duplicado à mão em `e2e/`:

- **Telas:** os links de `src/lib/nav.ts` (menu, relatórios e rodapé) + os prefixos de `ROUTE_ALLOWLIST` (`src/lib/role-utils.ts`)
  + `/perfil`. Rota nova no menu ou na allowlist entra no teste sozinha.
- **Quem deve ver:** `canAccessRoute(papel, rota)`, a mesma regra do servidor.
- **Fora do escopo:** rotas com parâmetro (`/flows/[id]`, `/contacts/[id]`…), que dependem de dados da conta, e telas sem entrada no
  menu nem na allowlist.

## Como o login com 2FA funciona

O app exige verificação em duas etapas (TOTP, nível `aal2`) para quem tem fator verificado. O robô:

1. abre `/login`, preenche e-mail e senha;
2. se cair em `/login/2fa`, gera o código de 6 dígitos a partir de `E2E_<PAPEL>_TOTP_SECRET` (RFC 6238, SHA-1, 30 s; implementado em
   `e2e/totp.ts`, sem dependência) e envia. Se o código está para expirar, espera a próxima janela e tenta de novo uma vez;
3. grava a sessão em `e2e/.auth/<papel>.json` (ignorado pelo git; é credencial) e reutiliza em todas as telas do papel.

## Criar os 4 usuários de teste

No ambiente da V2 (ex.: `https://omnicrmv2dev.grupoddm.ia.br`), numa conta **de teste** (nunca a de um cliente):

1. Crie 4 usuários com e-mails próprios, por exemplo `e2e-proprietario@…`, `e2e-admin@…`, `e2e-supervisor@…`, `e2e-operador@…`:
   o proprietário é o dono da conta de teste; os outros 3 entram em **Usuários** com os papéis Admin, Supervisor e Operador
   (papéis de sistema, não personalizados). O supervisor deve estar em ao menos uma equipe.
2. Para cada usuário, entre uma vez, vá em **Segurança** e ative a verificação em duas etapas. Na tela do QR code, copie o
   **segredo em texto** (base32, algo como `JBSWY3DPEHPK3PXP`) antes de confirmar: ele é o `E2E_<PAPEL>_TOTP_SECRET`.
   Cadastre também o QR no seu autenticador, para poder entrar manualmente se precisar. Não é possível recuperar o segredo depois.
3. Use senhas longas e exclusivas desses usuários. Dê a eles só o que o papel dá; não os coloque em contas com dados reais.

## Variáveis de ambiente / Secrets

| Variável | Conteúdo |
| --- | --- |
| `E2E_BASE_URL` | URL do ambiente, sem barra final (ex.: `https://omnicrmv2dev.grupoddm.ia.br`) |
| `E2E_PROPRIETARIO_EMAIL` / `_PASSWORD` / `_TOTP_SECRET` | Proprietário |
| `E2E_ADMIN_EMAIL` / `_PASSWORD` / `_TOTP_SECRET` | Admin |
| `E2E_SUPERVISOR_EMAIL` / `_PASSWORD` / `_TOTP_SECRET` | Supervisor |
| `E2E_OPERADOR_EMAIL` / `_PASSWORD` / `_TOTP_SECRET` | Operador |
| `E2E_ROLES` (opcional) | Subconjunto, ex.: `admin,operador` (padrão: os 4) |
| `E2E_WORKERS` (opcional) | Paralelismo (padrão 4) |
| `E2E_IGNORE_CONSOLE` (opcional) | Regex de ruído de console a ignorar nesta execução (ver `e2e/ignore.ts`) |

`_TOTP_SECRET` só é obrigatório para quem tem 2FA ativo (na V2, todos).

## Rodar no GitHub Actions (manual)

1. Em **Settings → Secrets and variables → Actions → New repository secret**, crie os 13 secrets da tabela (`E2E_BASE_URL` + 4 × 3).
2. Em **Actions → "E2E das telas" → Run workflow**. Opcional: informar a URL e os papéis. O workflow **não** roda em PR nem em push.
3. Ao terminar, baixe o artefato `e2e-telas-relatorio`: `e2e/report/index.html` é o relatório; falhas trazem captura de tela,
   vídeo e trace (`npx playwright show-trace <arquivo>`).

Sugestão de uso: rodar antes e depois de cada deploy da V2.

## Rodar na máquina

```bash
npm ci
npm run e2e:install        # baixa o Chromium (uma vez)
export E2E_BASE_URL=https://omnicrmv2dev.grupoddm.ia.br
export E2E_ADMIN_EMAIL=… E2E_ADMIN_PASSWORD=… E2E_ADMIN_TOTP_SECRET=…   # e os demais papéis
npm run e2e:telas
npx playwright show-report e2e/report
```

Duração esperada: 3 a 5 minutos para 4 papéis × ~30 telas com 4 workers.

## Lendo uma falha

- **"devia cair em /unauthorized"**: o papel abriu uma tela que a matriz bloqueia → falta o gate no app ou a matriz está errada.
- **"devia ver … mas foi para /unauthorized"**: o contrário; confira `ROUTE_ALLOWLIST`, `PAGE_MATRIX` e o papel do usuário de teste.
- **"erro de JS" / "console.error"**: a mensagem vem na falha; a captura e o trace mostram a tela. Ruído conhecido e inofensivo pode
  entrar em `e2e/ignore.ts` (com justificativa).
- **"o código TOTP foi recusado"**: segredo errado ou relógio do runner fora de hora.
- **`/api/me/permissions` diverge**: o servidor monta `pages` com os prefixos de `ROUTE_ALLOWLIST`; a diferença lista os prefixos.

## Manutenção

- Typecheck do e2e: `npm run e2e:typecheck` (o `tsconfig.json` da raiz exclui `e2e/`).
- Versão do Playwright fixa em `package.json` (`@playwright/test`); atualize de propósito, não por `^`.

# Primeiro deploy no cPanel — domínio de homologação

Este documento cobre **apenas o primeiro deploy**, antes da migração para
MariaDB. O objetivo é responder uma pergunta: a hospedagem aguenta rodar esta
aplicação?

A troca de banco vem depois, em [migracao-cpanel.md](migracao-cpanel.md).

## Regra deste deploy

**Não copie o `.env` de produção para o domínio novo.**

O código ainda depende inteiramente do Supabase. Com as chaves de produção, a
aplicação de homologação passa a:

- escrever no banco real — a `service_role` ignora toda a RLS;
- concorrer pelos eventos do webhook da Meta, que passaria a ter dois consumidores;
- disparar WhatsApp de verdade para contatos reais, se o worker do disparador subir.

Não é risco teórico. É o comportamento padrão de copiar o `.env`.

Use o modelo [`.env.homologacao.example`](../.env.homologacao.example): a aplicação
sobe com placeholders, e as telas que dependem do banco dão erro. Isso é esperado
e suficiente para validar a hospedagem.

## O que este deploy valida

| Pergunta | Como saber |
| --- | --- |
| O `nvm` tem a versão de Node exigida? | A tarefa `nvm use 20.19.0` não falha |
| O build sobrevive ao limite de memória? | `npm run build` termina sem `Killed` |
| O Passenger sobe o `app.js`? | A raiz do domínio responde |
| HTTPS e certificado funcionam? | Cadeado no navegador |
| Os assets estáticos são servidos? | A tela de login renderiza com estilo |
| O disco aguenta? | `node_modules` + `.next` cabem na cota |

## Pré-requisitos no cPanel

Levante antes de começar, porque dois deles podem inviabilizar o desenho atual:

- versão do Node disponível e se existe `nvm` na conta;
- **Setup Node.js App** ou **Application Manager** habilitado;
- acesso SSH;
- memória disponível para o build;
- espaço em disco;
- **Redis** — o worker do disparador usa fila BullMQ, que só funciona com Redis.
  Hospedagem compartilhada normalmente não oferece. Sem Redis, a fila precisa ser
  reescrita sobre tabela;
- **processos persistentes** — o worker do disparador e o serviço Go de VoIP
  precisam ficar vivos. Muitos cPanel matam processo longo;
- versão do MariaDB/MySQL (para a fase seguinte).

## Passos

### 1. Criar o subdomínio

Crie o subdomínio de homologação apontando para um diretório **próprio**, fora do
diretório da aplicação atual (`$HOME/apps/omnichannel`).

### 2. Criar a aplicação Node

Em **Setup Node.js App**:

| Campo | Valor |
| --- | --- |
| Node.js version | 20.x |
| Application mode | Production |
| Application root | o diretório do subdomínio |
| Application URL | o subdomínio de homologação |
| Application startup file | `app.js` |

### 3. Configurar o deploy via Git

Aponte o repositório para a branch `migration/cpanel-mariadb`.

O [`.cpanel.yml`](../.cpanel.yml) reinicia a aplicação tocando
`$PWD/tmp/restart.txt` — o diretório do deploy, não um caminho fixo. Cada domínio
reinicia o próprio app.

### 4. Criar o `.env` no servidor

O `.env` não vai pelo Git. Crie na mão, no diretório da aplicação, a partir do
modelo `.env.homologacao.example`.

Gere uma `ENCRYPTION_KEY` **nova**, só para homologação:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Nunca reaproveite a chave de produção.

### 5. Rodar o deploy

Dispare o deploy pelo cPanel e acompanhe a saída das tarefas.

## Problemas esperados — e o que significam

| Sintoma | Significado |
| --- | --- |
| `/api/calls/*` retorna 502 | Esperado. O serviço Go de VoIP não sobe neste deploy |
| Telas de dados vazias ou com erro | Esperado. Os placeholders do Supabase não resolvem |
| `npm run build` morre com `Killed` | Memória insuficiente. Precisa de build local + upload, ou plano maior |
| `nvm: command not found` | `nvm` não instalado na conta. Use a versão de Node do painel |
| Deploy verde mas o site não muda | O `restart.txt` foi para o diretório errado. Confira o Application root |
| Página sem estilo, `/_next/static/*` em 404 | Cache de CDN servindo HTML antigo. Veja a nota de `Cache-Control` no `next.config.ts` |

## O que **não** fazer neste deploy

- não apontar o webhook da Meta para este domínio;
- não criar cron job neste domínio;
- não subir o worker do disparador;
- não usar a `ENCRYPTION_KEY` de produção;
- não copiar o `.env` de produção.

## Depois que subir

Com a hospedagem validada, começa a fase do banco: criar o MariaDB de
homologação no cPanel, escrever as migrations convertidas, importar o dump e
trocar a camada de dados da aplicação. O roteiro está em
[migracao-cpanel.md](migracao-cpanel.md).

# Scripts de exportacao do Supabase

Ferramental da migracao Supabase/PostgreSQL -> cPanel/MariaDB.
Rodam **somente leitura** contra o Supabase: nao alteram nada em producao.

## Onde os dados caem

Tudo vai para fora do repositorio, em `%USERPROFILE%\Downloads\CRM-DDM-backup\dump`:

```
CRM-DDM-backup/
├── .tools/pgsql/bin/        cliente PostgreSQL (psql, pg_dump)
└── dump/
    ├── schema.sql           DDL sem owners
    ├── schema_full.sql      DDL com owners e politicas RLS
    ├── data.sql             dados (wacrm + public)
    ├── backup.dump          formato custom do pg_dump
    ├── tables.csv           inventario de tabelas
    ├── row_counts.csv       contagem por tabela (base da validacao pos-import)
    ├── storage_objects.csv  inventario do Storage (nao sao os arquivos)
    ├── storage_buckets.csv  configuracao dos buckets
    ├── storage/             os arquivos em si, por bucket
    ├── storage_manifest.csv resultado do download
    └── secrets/             hashes de senha e tokens - SEGREDO
```

`dump/` e `secrets/` estao no `.gitignore`. Nunca versione nem envie por chat.

## Pre-requisito

O cliente PostgreSQL precisa existir em `CRM-DDM-backup\.tools\pgsql\bin`.
Se nao existir, extraia o zip oficial do PostgreSQL para `CRM-DDM-backup\.tools`.

## Ordem de execucao

Substitua `<project-ref>` pelo identificador do projeto Supabase
(aparece no host do pooler: `postgres.<project-ref>`).

### 1. Schema, dados e inventarios

```powershell
powershell -ExecutionPolicy Bypass -File scripts\migration\export-database.ps1 `
  -PgHost "aws-1-sa-east-1.pooler.supabase.com" -User "postgres.<project-ref>"

powershell -ExecutionPolicy Bypass -File scripts\migration\export-inventory.ps1 `
  -PgHost "aws-1-sa-east-1.pooler.supabase.com" -User "postgres.<project-ref>"
```

### 2. Usuarios com hash de senha

```powershell
powershell -ExecutionPolicy Bypass -File scripts\migration\export-auth.ps1 `
  -PgHost "aws-1-sa-east-1.pooler.supabase.com" -User "postgres.<project-ref>"
```

Gera `dump/secrets/`. O Supabase guarda as senhas em bcrypt (`$2a$`), que o Node
consegue verificar com `bcryptjs`. Ter esse arquivo mantem aberta a opcao de
migrar sem obrigar os 26 usuarios a redefinir a senha na virada.

### 3. Arquivos do Storage

```powershell
powershell -ExecutionPolicy Bypass -File scripts\migration\export-storage.ps1 `
  -SupabaseUrl "https://<project-ref>.supabase.co"
```

O dump do PostgreSQL **nao** contem os arquivos dos buckets, so o inventario.
Este script le `storage_objects.csv` e baixa objeto por objeto.

E retomavel: arquivo ja baixado com o tamanho esperado e pulado. Se terminar com
falhas, rode de novo - ele tenta so o que faltou. Pede a chave `service_role`,
que fica apenas em memoria durante a execucao.

## Segredos

Senha do banco e chave `service_role` sao digitadas na hora, ficam so no processo
e nunca vao para arquivo, variavel persistente ou historico do PowerShell.

A `SUPABASE_SERVICE_ROLE_KEY` que estava escrita nos scripts de diagnostico foi
removida do codigo, mas **remover do arquivo nao revoga o acesso**: ela ainda
precisa ser rotacionada no painel do Supabase, em conjunto com quem mantem a
aplicacao publicada hoje.

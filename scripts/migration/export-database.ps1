<#
  export-database.ps1

  Exporta schema, dados e inventarios do Supabase para arquivos locais.
  Somente leitura: nao altera nada em producao.

  Uso:
    powershell -ExecutionPolicy Bypass -File scripts\migration\export-database.ps1 `
      -PgHost "aws-1-sa-east-1.pooler.supabase.com" `
      -User   "postgres.<project-ref>"
#>
param(
  [Parameter(Mandatory=$true)][string]$PgHost,
  [Parameter(Mandatory=$true)][string]$User,
  [int]$Port = 5432,
  [string]$Database = "postgres",
  [string]$Bin = "$env:USERPROFILE\Downloads\CRM-DDM-backup\.tools\pgsql\bin",
  [string]$Out = "$env:USERPROFILE\Downloads\CRM-DDM-backup\dump"
)

$ErrorActionPreference = "Continue"

$PgDump    = Join-Path $Bin "pg_dump.exe"
$PgDumpAll = Join-Path $Bin "pg_dumpall.exe"
$Psql      = Join-Path $Bin "psql.exe"

if (-not (Test-Path $PgDump)) { Write-Host "pg_dump nao encontrado em $Bin"; exit 1 }
New-Item -ItemType Directory -Force -Path $Out | Out-Null

# Senha: digitada agora, vive so neste processo. Nao vai para arquivo nem historico.
$sec = Read-Host -Prompt "Senha do banco (nao aparece na tela)" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
$env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
$env:PGSSLMODE = "require"

$conn = @("-h", $PgHost, "-p", $Port, "-U", $User, "-d", $Database)

function Step($label, $block) {
  Write-Host ""
  Write-Host "==> $label"
  & $block
  if ($LASTEXITCODE -eq 0) { Write-Host "    ok" } else { Write-Host "    FALHOU (exit $LASTEXITCODE)" }
}

Step "conexao" { & $Psql @conn -v ON_ERROR_STOP=1 -c "select current_user, current_database(), version();" }

# pg_dumpall nao aceita -d: a base vai em -l. Com @conn ele falha com
# 'faltando "=" apos "postgres" na cadeia de conexao'.
Step "roles.sql" {
  & $PgDumpAll -h $PgHost -p $Port -U $User -l $Database --globals-only --no-role-passwords -f "$Out\roles.sql"
}

Step "schema.sql (wacrm + public)" {
  & $PgDump @conn --schema-only --no-owner --no-privileges -n wacrm -n public -f "$Out\schema.sql"
}

Step "schema_full.sql (com owners/RLS)" {
  & $PgDump @conn --schema-only -n wacrm -n public -f "$Out\schema_full.sql"
}

Step "data.sql (wacrm + public)" {
  & $PgDump @conn --data-only --no-owner --disable-triggers -n wacrm -n public -f "$Out\data.sql"
}

Step "backup.dump (formato custom)" {
  & $PgDump @conn -Fc --no-owner -n wacrm -n public -f "$Out\backup.dump"
}

Step "auth_users.csv" {
  & $Psql @conn -v ON_ERROR_STOP=1 -c "\copy (select id, email, phone, created_at, last_sign_in_at, raw_user_meta_data, raw_app_meta_data, email_confirmed_at, banned_until, deleted_at from auth.users order by created_at) to '$Out\auth_users.csv' with (format csv, header)"
}

Step "storage_objects.csv" {
  & $Psql @conn -v ON_ERROR_STOP=1 -c "\copy (select id, bucket_id, name, owner, created_at, updated_at, metadata from storage.objects order by created_at) to '$Out\storage_objects.csv' with (format csv, header)"
}

Step "inventario de tabelas" {
  & $Psql @conn -c "\copy (select table_schema, table_name from information_schema.tables where table_schema in ('wacrm','public') and table_type='BASE TABLE' order by 1,2) to '$Out\tables.csv' with (format csv, header)"
}

$env:PGPASSWORD = $null

Write-Host ""
Write-Host "Arquivos gerados:"
Get-ChildItem $Out | Select-Object Name, @{n="MB";e={[math]::Round($_.Length/1MB,2)}} | Format-Table -AutoSize

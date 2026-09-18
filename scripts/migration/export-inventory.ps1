<#
  export-inventory.ps1

  Complementa o export-database.ps1: roles, grants e contagem real de linhas
  por tabela. O row_counts.csv e a base da validacao depois do import no MariaDB.
  Somente leitura.

  Uso:
    powershell -ExecutionPolicy Bypass -File scripts\migration\export-inventory.ps1 `
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

$PgDumpAll = Join-Path $Bin "pg_dumpall.exe"
$Psql      = Join-Path $Bin "psql.exe"

$sec = Read-Host -Prompt "Senha do banco (nao aparece na tela)" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
$env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
$env:PGSSLMODE = "require"

Write-Host "==> roles.sql (via -l)"
& $PgDumpAll -h $PgHost -p $Port -U $User -l $Database --globals-only --no-role-passwords -f "$Out\roles.sql"
if ($LASTEXITCODE -eq 0) { Write-Host "    ok" } else { Write-Host "    FALHOU (exit $LASTEXITCODE) - fallback abaixo" }

Write-Host "==> roles_fallback.csv (catalogo)"
& $Psql -h $PgHost -p $Port -U $User -d $Database -c "\copy (select rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls, rolconnlimit, rolvaliduntil from pg_roles order by rolname) to '$Out\roles_fallback.csv' with (format csv, header)"

Write-Host "==> grants.csv (permissoes de tabela)"
& $Psql -h $PgHost -p $Port -U $User -d $Database -c "\copy (select table_schema, table_name, grantee, privilege_type from information_schema.role_table_grants where table_schema in ('wacrm','public') order by 1,2,3,4) to '$Out\grants.csv' with (format csv, header)"

Write-Host "==> row_counts.csv (contagem real por tabela)"
& $Psql -h $PgHost -p $Port -U $User -d $Database -c "\copy (select schemaname, relname, n_live_tup from pg_stat_user_tables where schemaname in ('wacrm','public') order by n_live_tup desc) to '$Out\row_counts.csv' with (format csv, header)"

$env:PGPASSWORD = $null
Get-ChildItem $Out | Select-Object Name, @{n="MB";e={[math]::Round($_.Length/1MB,4)}} | Format-Table -AutoSize

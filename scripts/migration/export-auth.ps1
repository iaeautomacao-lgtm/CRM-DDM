<#
  export-auth.ps1

  Exporta o schema auth do Supabase, INCLUINDO os hashes de senha
  (auth.users.encrypted_password). Isso permite migrar os usuarios para o
  MariaDB sem obrigar todo mundo a redefinir a senha na virada.

  ATENCAO: os arquivos gerados em dump\secrets sao SEGREDOS.
  Contem hashes de senha e tokens de recuperacao. Nunca versione no Git,
  nunca envie por chat/e-mail, apague apos concluir a migracao.

  Uso:
    powershell -ExecutionPolicy Bypass -File scripts\migration\export-auth.ps1 `
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

$Psql = Join-Path $Bin "psql.exe"
if (-not (Test-Path $Psql)) { Write-Host "psql.exe nao encontrado em $Bin"; exit 1 }

$Secrets = Join-Path $Out "secrets"
New-Item -ItemType Directory -Force -Path $Secrets | Out-Null

# Senha: digitada agora, vive so neste processo. Nao vai para arquivo nem historico.
$sec  = Read-Host -Prompt "Senha do banco (nao aparece na tela)" -AsSecureString
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

# Mostra so o prefixo do algoritmo ($2a$ = bcrypt), nunca o hash inteiro.
Step "conferir algoritmo de hash das senhas" {
  & $Psql @conn -c "select substring(encrypted_password from 1 for 4) as algoritmo, count(*) as usuarios from auth.users where encrypted_password is not null group by 1 order by 2 desc;"
}

# select * e proposital: o layout de auth.users muda entre versoes do Supabase.
Step "secrets\auth_users_full.csv (COM hash de senha)" {
  & $Psql @conn -v ON_ERROR_STOP=1 -c "\copy (select * from auth.users order by created_at) to '$Secrets\auth_users_full.csv' with (format csv, header)"
}

Step "secrets\auth_identities.csv (provedores de login)" {
  & $Psql @conn -v ON_ERROR_STOP=1 -c "\copy (select * from auth.identities order by created_at) to '$Secrets\auth_identities.csv' with (format csv, header)"
}

# Pode nao existir dependendo da versao/config. Falha aqui nao bloqueia o resto.
Step "secrets\auth_mfa_factors.csv (2FA, opcional)" {
  & $Psql @conn -c "\copy (select * from auth.mfa_factors order by created_at) to '$Secrets\auth_mfa_factors.csv' with (format csv, header)"
}

Step "storage_buckets.csv (configuracao dos buckets)" {
  & $Psql @conn -v ON_ERROR_STOP=1 -c "\copy (select * from storage.buckets order by created_at) to '$Out\storage_buckets.csv' with (format csv, header)"
}

$env:PGPASSWORD = $null

Write-Host ""
Write-Host "Gerados em $Secrets (TRATAR COMO SEGREDO):"
Get-ChildItem $Secrets | Select-Object Name, @{n="KB";e={[math]::Round($_.Length/1KB,1)}} | Format-Table -AutoSize

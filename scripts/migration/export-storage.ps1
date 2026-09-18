<#
  export-storage.ps1

  Baixa os arquivos do Supabase Storage. O dump do PostgreSQL NAO contem os
  arquivos: storage_objects.csv e so o inventario. Este script le esse
  inventario e baixa cada objeto preservando bucket e caminho.

  E retomavel: arquivo ja baixado com o tamanho esperado e pulado.
  Pode rodar de novo quantas vezes precisar.

  A chave service_role e pedida na hora e vive so neste processo.

  Uso:
    powershell -ExecutionPolicy Bypass -File scripts\migration\export-storage.ps1 `
      -SupabaseUrl "https://<project-ref>.supabase.co"
#>
param(
  [Parameter(Mandatory=$true)][string]$SupabaseUrl,
  [string]$Out        = "$env:USERPROFILE\Downloads\CRM-DDM-backup\dump",
  [string]$ObjectsCsv = "",
  [int]$MaxRetries    = 3
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$SupabaseUrl = $SupabaseUrl.TrimEnd("/")
if ([string]::IsNullOrWhiteSpace($ObjectsCsv)) { $ObjectsCsv = Join-Path $Out "storage_objects.csv" }
if (-not (Test-Path $ObjectsCsv)) { Write-Host "inventario nao encontrado: $ObjectsCsv"; exit 1 }

$StorageRoot = Join-Path $Out "storage"
New-Item -ItemType Directory -Force -Path $StorageRoot | Out-Null
$ManifestPath = Join-Path $Out "storage_manifest.csv"

# Chave service_role: digitada agora, nao vai para arquivo nem historico.
$sec  = Read-Host -Prompt "SUPABASE_SERVICE_ROLE_KEY (nao aparece na tela)" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
$key  = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)

$headers = @{ "Authorization" = "Bearer $key"; "apikey" = $key }

# Codifica cada segmento do caminho, mantendo as barras.
function Encode-Path([string]$p) {
  ($p -split "/" | ForEach-Object { [System.Uri]::EscapeDataString($_) }) -join "/"
}

$objects = Import-Csv -Path $ObjectsCsv
$total   = $objects.Count
Write-Host "objetos no inventario: $total"
Write-Host "destino: $StorageRoot"
Write-Host ""

$rows = New-Object System.Collections.ArrayList
$i = 0; $ok = 0; $skip = 0; $fail = 0

foreach ($o in $objects) {
  $i++
  $bucket = $o.bucket_id
  $name   = $o.name

  if ([string]::IsNullOrWhiteSpace($bucket) -or [string]::IsNullOrWhiteSpace($name)) {
    $fail++
    [void]$rows.Add([pscustomobject]@{ bucket=$bucket; name=$name; local=""; bytes=0; status="INVALIDO" })
    continue
  }

  # Tamanho esperado, quando o metadata traz.
  $expected = 0
  if (-not [string]::IsNullOrWhiteSpace($o.metadata)) {
    try { $m = $o.metadata | ConvertFrom-Json; if ($null -ne $m.size) { $expected = [int64]$m.size } } catch { }
  }

  $localPath = Join-Path $StorageRoot ((Join-Path $bucket $name) -replace "/", "\")
  $localDir  = Split-Path -Parent $localPath
  if (-not (Test-Path $localDir)) { New-Item -ItemType Directory -Force -Path $localDir | Out-Null }

  if (Test-Path $localPath) {
    $have = (Get-Item $localPath).Length
    if ($have -gt 0 -and ($expected -eq 0 -or $have -eq $expected)) {
      $skip++
      [void]$rows.Add([pscustomobject]@{ bucket=$bucket; name=$name; local=$localPath; bytes=$have; status="JA_EXISTIA" })
      if ($i % 100 -eq 0) { Write-Host "  $i/$total  ok=$ok pulados=$skip falhas=$fail" }
      continue
    }
  }

  $url = "$SupabaseUrl/storage/v1/object/$(Encode-Path $bucket)/$(Encode-Path $name)"
  $done = $false
  for ($try = 1; $try -le $MaxRetries -and -not $done; $try++) {
    try {
      Invoke-WebRequest -Uri $url -Headers $headers -OutFile $localPath -UseBasicParsing -TimeoutSec 120
      $done = $true
    } catch {
      if ($try -eq $MaxRetries) {
        $fail++
        [void]$rows.Add([pscustomobject]@{ bucket=$bucket; name=$name; local=$localPath; bytes=0; status="FALHA: $($_.Exception.Message)" })
      } else {
        Start-Sleep -Seconds ([math]::Pow(2, $try))
      }
    }
  }

  if ($done) {
    $got = (Get-Item $localPath).Length
    $st = "OK"
    if ($expected -gt 0 -and $got -ne $expected) { $st = "TAMANHO_DIVERGENTE (esperado $expected)" }
    $ok++
    [void]$rows.Add([pscustomobject]@{ bucket=$bucket; name=$name; local=$localPath; bytes=$got; status=$st })
  }

  if ($i % 100 -eq 0) { Write-Host "  $i/$total  ok=$ok pulados=$skip falhas=$fail" }
}

$key = $null
$headers = $null

$rows | Export-Csv -Path $ManifestPath -NoTypeInformation -Encoding UTF8

Write-Host ""
Write-Host "==> resumo"
Write-Host "  baixados        : $ok"
Write-Host "  ja existiam     : $skip"
Write-Host "  falhas          : $fail"
Write-Host "  manifesto       : $ManifestPath"
Write-Host ""
$rows | Group-Object bucket | Select-Object Name, Count | Format-Table -AutoSize
$mb = [math]::Round((Get-ChildItem $StorageRoot -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB, 2)
Write-Host "total em disco: $mb MB"
if ($fail -gt 0) { Write-Host "Rode de novo para tentar as $fail falhas (o script pula o que ja baixou)." }

# =====================================================================
# setup.ps1 — TenisCash Fiscal Agent (instalador único)
# =====================================================================
# Idempotente. Pode rodar mais de uma vez sem efeito colateral.
# Aborta com erro CLARO se qualquer etapa falhar.
# Auto-valida no final via GET /health — só imprime SUCESSO se passou.
#
# Uso: PowerShell admin → cd C:\TenisCashAgent → .\setup.ps1
# =====================================================================

$ErrorActionPreference = 'Stop'
$WORK = 'C:\TenisCashAgent'
$AGENT_URL = 'http://100.106.212.108:8000'

function Step($n, $msg) { Write-Host ("[$n] $msg") -ForegroundColor Cyan }
function Ok($msg)  { Write-Host ("  OK $msg") -ForegroundColor Green }
function Fail($msg) { Write-Host ("  FALHA: $msg") -ForegroundColor Red; exit 1 }

Write-Host '=== TenisCash Fiscal Agent — setup ===' -ForegroundColor Cyan
Write-Host ''

# Verifica admin
if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] 'Administrator')) {
  Fail 'Não está rodando como Administrador. Abra PowerShell admin (Win+X → Terminal Administrador).'
}

# 1. Node
Step 1 'Verificando Node.js (>= 20)'
$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
$nodeOk = $false
try {
  $v = & node --version 2>$null
  if ($v -and ([int](($v -replace '[^0-9.]','') -split '\.')[0]) -ge 20) { $nodeOk = $true; Ok "Node $v" }
} catch {}
if (-not $nodeOk) {
  Write-Host '  Instalando Node 20 LTS via winget...'
  & winget install --id=OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements | Out-Null
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
  try { $v = & node --version } catch { Fail 'Node não instalou. Reinicia o PowerShell e roda de novo.' }
  Ok "Node $v instalado"
}

# 2. Diretório de trabalho
Step 2 "Diretório $WORK"
if (-not (Test-Path $WORK)) { New-Item -ItemType Directory -Force -Path $WORK | Out-Null }
Set-Location $WORK
Ok 'pronto'

# 3. Baixar fontes
Step 3 'Baixando agente da matriz via Tailscale'
$files = @('index.js', 'fiscalSefazDirect.mjs', 'fiscalAcquirers.js', 'package.json')
foreach ($f in $files) {
  try {
    Invoke-WebRequest -Uri "$AGENT_URL/$f" -OutFile "$WORK\$f" -UseBasicParsing -TimeoutSec 30
    Ok $f
  } catch { Fail "Falha ao baixar $f de $AGENT_URL — Tailscale conectado? Matriz online?" }
}

# 4. npm install
Step 4 'Instalando dependências'
$null = & npm install --silent 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host '  npm install falhou. Rodando verbose:'
  & npm install
  Fail 'npm install falhou — ver erro acima'
}
Ok 'dependências OK'

# 5. .env (lê automaticamente do Chianca se disponível, ou pergunta)
Step 5 'Configurando .env'
$envFile = "$WORK\.env"
if (Test-Path $envFile) {
  Ok '.env já existe — preservando'
} else {
  # Tenta achar PFX automaticamente
  $pfxPath = $null
  $pfxSenha = $null
  $storeLabel = Read-Host 'Codigo desta loja (ex: LOJA03)'

  # Procura pasta NFe_Emissao* com .pfx dentro
  if (Test-Path 'C:\Chianca') {
    $nfePastas = Get-ChildItem 'C:\Chianca' -Directory -Filter 'NFe_Emissao*' -ErrorAction SilentlyContinue
    foreach ($p in $nfePastas) {
      $pfxs = Get-ChildItem $p.FullName -Filter '*.pfx' -ErrorAction SilentlyContinue
      if ($pfxs) {
        $pfxPath = $pfxs[0].FullName
        # tenta ler senha do ConfigNFe.ini
        $ini = Join-Path $p.FullName 'ConfigNFe.ini'
        if (Test-Path $ini) {
          $raw = Get-Content $ini -Raw
          $m = [regex]::Match($raw, 'ACESSO\s*=>?\s*([^\r\n]+)')
          if ($m.Success) { $pfxSenha = $m.Groups[1].Value.Trim() }
        }
        break
      }
    }
  }

  if (-not $pfxPath) {
    $pfxPath = Read-Host 'Caminho do PFX (ex: C:\Chianca\NFe_Emissao003\Certificado2026.pfx)'
    if (-not (Test-Path $pfxPath)) { Fail "PFX não existe: $pfxPath" }
  } else {
    Write-Host "  PFX detectado: $pfxPath" -ForegroundColor Gray
  }
  if (-not $pfxSenha) {
    $sec = Read-Host 'Senha do PFX' -AsSecureString
    $pfxSenha = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
  } else {
    Write-Host '  Senha PFX lida do ConfigNFe.ini' -ForegroundColor Gray
  }

  $token = -join ((48..57)+(97..122) | Get-Random -Count 32 | ForEach-Object {[char]$_})

  # Escrita ASCII sem BOM, line endings Unix
  $content = "PORT=8765`nAGENT_TOKEN=$token`nSTORE_LABEL=$storeLabel`nPFX_PATH=$pfxPath`nPFX_SENHA=$pfxSenha`n"
  [System.IO.File]::WriteAllText($envFile, $content, [System.Text.UTF8Encoding]::new($false))
  Ok ".env criado (encoding UTF-8 sem BOM)"
  Write-Host ''
  Write-Host '=== AGENT_TOKEN ===' -ForegroundColor Yellow
  Write-Host $token -ForegroundColor Yellow
  Write-Host '===================' -ForegroundColor Yellow
  Write-Host ''
}

# 6. Scheduled Task
Step 6 'Registrando Scheduled Task TenisCashFiscalAgent'
$taskName = 'TenisCashFiscalAgent'
$nodeExe = (Get-Command node).Source
$action = New-ScheduledTaskAction -Execute $nodeExe -Argument 'index.js' -WorkingDirectory $WORK
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
Ok 'task registrada'

# 7. Para qualquer instância antiga e inicia
Step 7 'Iniciando agente'
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$WORK\*" -or $_.MainModule.FileName -like "$WORK\*" } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 5
Ok 'task iniciada'

# 8. Auto-validar /health
Step 8 'Validando GET /health'
$health = $null
for ($i = 1; $i -le 10; $i++) {
  try {
    $r = Invoke-WebRequest -Uri 'http://localhost:8765/health' -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) { $health = $r.Content | ConvertFrom-Json; break }
  } catch { Start-Sleep -Seconds 1 }
}
if (-not $health) {
  Write-Host '  Agente não respondeu /health após 10s. Log:' -ForegroundColor Red
  if (Test-Path "$WORK\agent.log") { Get-Content "$WORK\agent.log" -Tail 20 }
  Fail 'agente não subiu — investigue agent.log'
}
if (-not $health.ok -or -not $health.pfxExists) {
  Write-Host '  /health retornou problema:' -ForegroundColor Red
  $health | Format-List
  Fail "PFX não acessível ou agente degradado"
}
Ok "store=$($health.store) port=$($health.port) pfxSize=$($health.pfxSize) version=$($health.version)"

# 9. Resumo final
Write-Host ''
Write-Host '=== INSTALAÇÃO VALIDADA ===' -ForegroundColor Green
Write-Host "Local: $WORK"
Write-Host 'Log: agent.log'
Write-Host 'Health: http://localhost:8765/health'
Write-Host ''
Write-Host 'AGENT_TOKEN (passar pra Douglas cadastrar no central):'
$envContent = Get-Content "$WORK\.env" -Raw
$tokenMatch = [regex]::Match($envContent, 'AGENT_TOKEN=([^\r\n]+)')
if ($tokenMatch.Success) { Write-Host ('  ' + $tokenMatch.Groups[1].Value) -ForegroundColor Yellow }
Write-Host ''
Write-Host '✓ tudo OK' -ForegroundColor Green

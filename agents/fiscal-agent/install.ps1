# =====================================================================
# install.ps1 — TenisCash Fiscal Agent (instalador local por loja)
# =====================================================================
# Roda como Administrador. Faz:
#   1) Verifica/instala Node 20 LTS (user scope, sem admin se já tiver)
#   2) Cria C:\TenisCashAgent\
#   3) Copia fonte (do diretório atual)
#   4) npm install
#   5) Cria .env interativo (pede CSC, senha PFX, etc)
#   6) Cria Scheduled Task "TenisCashFiscalAgent" pra rodar no boot
#   7) Start imediato
# =====================================================================

$ErrorActionPreference = 'Stop'
Write-Host '=== TenisCash Fiscal Agent — Instalador ===' -ForegroundColor Cyan

# 1) Node check
$nodeVer = $null
try { $nodeVer = & node --version 2>$null } catch {}
if (-not $nodeVer -or [int]($nodeVer -replace '[^0-9.]','' -split '\.')[0] -lt 20) {
  Write-Host '[1/6] Instalando Node.js 20 LTS...'
  winget install --id=OpenJS.NodeJS.LTS -e --silent --scope=user --accept-source-agreements --accept-package-agreements
  $env:Path = [Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine')
  $nodeVer = & node --version
}
Write-Host "  OK Node $nodeVer"

# 2) Destino
$dst = 'C:\TenisCashAgent'
if (-not (Test-Path $dst)) { New-Item -ItemType Directory $dst | Out-Null }
Write-Host "[2/6] Pasta destino: $dst"

# 3) Copia fontes (do diretório atual do script)
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host '[3/6] Copiando arquivos...'
Copy-Item "$src\index.js","$src\fiscalSefazDirect.mjs","$src\fiscalAcquirers.js","$src\package.json" -Destination $dst -Force
if (-not (Test-Path "$dst\.env.example")) { Copy-Item "$src\.env.example" $dst -Force }

# 4) npm install
Write-Host '[4/6] npm install (pode demorar ~1 min)...'
Push-Location $dst
& npm install --silent 2>&1 | Out-Null
Pop-Location
Write-Host '  OK dependências instaladas'

# 5) .env interativo
$envFile = "$dst\.env"
if (-not (Test-Path $envFile)) {
  Write-Host '[5/6] Configurando .env (responda os prompts)...'
  $storeCode = Read-Host 'Codigo da loja (ex: LOJA03)'
  $cnpj = Read-Host 'CNPJ (so digitos, ex: 44052617000398)'
  $pfxPath = Read-Host 'Caminho do PFX (ex: C:\Chianca\NFe_Emissao003\Certificado2026.pfx)'
  $pfxSenha = Read-Host 'Senha do PFX' -AsSecureString
  $pfxSenhaPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($pfxSenha))
  $csc = Read-Host 'CSC token (do ConfigCHShop.ini, codigo_csc)'
  $cscId = Read-Host 'CSC ID (geralmente 000001)'
  $env_ = Read-Host 'Ambiente [homologation/production]'
  if (-not $env_) { $env_ = 'homologation' }
  $token = -join ((48..57)+(97..122) | Get-Random -Count 32 | ForEach-Object {[char]$_})

  $envContent = @"
PORT=8765
AGENT_TOKEN=$token
STORE_CODE=$storeCode
CNPJ=$cnpj
PFX_PATH=$pfxPath
PFX_SENHA=$pfxSenhaPlain
CSC=$csc
CSC_ID=$cscId
ENVIRONMENT=$env_
NFCE_SERIE=1
NFCE_NEXT_NUMBER=1
NFE_SERIE=1
NFE_NEXT_NUMBER=1
COMPANY_NAME=
FANTASY_NAME=
IE=
STREET=
NUMBER=
NEIGHBORHOOD=
CITY=JOAO PESSOA
STATE=PB
ZIP=
CITY_CODE=2507507
PHONE=
CRT=3
"@
  Set-Content -Path $envFile -Value $envContent -Encoding ASCII
  Write-Host "  OK .env criado em $envFile"
  Write-Host "  Token gerado: $token" -ForegroundColor Yellow
  Write-Host "  Copie esse token e envie pelo TenisCash central pro Store.fiscalAgentToken" -ForegroundColor Yellow
} else {
  Write-Host '[5/6] .env já existe, pulando configuração'
}

# 6) Scheduled Task
Write-Host '[6/6] Registrando Scheduled Task...'
$taskName = 'TenisCashFiscalAgent'
$action = New-ScheduledTaskAction -Execute (Get-Command node).Source -Argument 'index.js' -WorkingDirectory $dst
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $taskName

Start-Sleep -Seconds 3
$tail = if (Test-Path "$dst\agent.log") { Get-Content "$dst\agent.log" -Tail 5 } else { '(sem log ainda)' }
Write-Host ''
Write-Host '=== INSTALAÇÃO CONCLUÍDA ===' -ForegroundColor Green
Write-Host "Log: $dst\agent.log"
Write-Host "Health: http://localhost:8765/health"
Write-Host ''
Write-Host '--- Últimas linhas do log: ---'
$tail | ForEach-Object { Write-Host $_ }

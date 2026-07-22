$ErrorActionPreference = 'Stop'

$agentEnv = 'C:\TenisCashAgent\.env'
$logFile = 'C:\TenisCash\CameraAgent\upload.log'
$segment = [Environment]::GetEnvironmentVariable('MTX_SEGMENT_PATH')
$camera = [Environment]::GetEnvironmentVariable('MTX_PATH')
$duration = [Environment]::GetEnvironmentVariable('MTX_SEGMENT_DURATION')

function Write-UploadLog([string]$message) {
    $line = '[{0}] {1}' -f (Get-Date).ToUniversalTime().ToString('o'), $message
    Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}

try {
    if (-not $segment -or -not (Test-Path -LiteralPath $segment)) { throw 'Segmento não encontrado.' }
    if ($camera -notmatch '^loja\d{2}_camera\d+$') { throw 'Nome de câmera inválido.' }
    if (-not (Test-Path -LiteralPath $agentEnv)) { throw 'Credencial do agente não encontrada.' }

    $tokenLine = Get-Content -LiteralPath $agentEnv | Where-Object { $_ -match '^AGENT_TOKEN=' } | Select-Object -First 1
    $token = ($tokenLine -replace '^AGENT_TOKEN=', '').Trim().Trim('"').Trim("'")
    if ($token.Length -lt 16) { throw 'Credencial do agente inválida.' }

    $file = Get-Item -LiteralPath $segment
    if ($file.Length -gt 90MB) {
        Write-UploadLog "LOCAL_ONLY camera=$camera arquivo=$($file.Name) bytes=$($file.Length) motivo=limite_nuvem"
        exit 0
    }

    $headers = @{
        'X-Agent-Token' = $token
        'X-Camera-Name' = $camera
        'X-Segment-Name' = $file.Name
        'X-Segment-Duration' = $duration
    }

    $lastError = $null
    foreach ($attempt in 1..3) {
        try {
            Invoke-WebRequest -UseBasicParsing -Uri 'https://www.teniscash.com.br/api/auth/agent-camera-segment' -Method Post -Headers $headers -ContentType 'application/octet-stream' -InFile $file.FullName -TimeoutSec 180 | Out-Null
            Write-UploadLog "UPLOADED camera=$camera arquivo=$($file.Name) bytes=$($file.Length)"
            exit 0
        } catch {
            $lastError = $_.Exception.Message
            Start-Sleep -Seconds (5 * $attempt)
        }
    }
    throw $lastError
} catch {
    Write-UploadLog "FAILED camera=$camera arquivo=$segment erro=$($_.Exception.Message)"
    exit 1
}

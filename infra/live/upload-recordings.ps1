$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = 'C:\TenisCash\CameraAgent'
$recordRoot = Join-Path $root 'recordings_clean'
$agentEnv = 'C:\TenisCashAgent\.env'
$logFile = Join-Path $root 'upload.log'
$cloudUrl = 'https://www.teniscash.com.br/api/auth/agent-camera-segment'
$segmentSeconds = 120

function Write-UploadLog([string]$message) {
    $line = '[{0}] {1}' -f (Get-Date).ToUniversalTime().ToString('o'), $message
    Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}

try {
    if (-not (Test-Path -LiteralPath $agentEnv)) { throw 'Agent credential not found.' }
    $tokenLine = Get-Content -LiteralPath $agentEnv | Where-Object { $_ -match '^AGENT_TOKEN=' } | Select-Object -First 1
    $token = ($tokenLine -replace '^AGENT_TOKEN=', '').Trim().Trim('"').Trim("'")
    if ($token.Length -lt 16) { throw 'Invalid agent credential.' }

    $readyBefore = (Get-Date).AddMinutes(-1)
    $files = Get-ChildItem -LiteralPath $recordRoot -Recurse -File -Filter '*.mp4' -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt $readyBefore -and -not (Test-Path -LiteralPath ($_.FullName + '.uploaded')) } |
        Sort-Object LastWriteTime |
        Select-Object -First 12

    foreach ($file in $files) {
        $camera = $file.Directory.Name
        if ($camera -notmatch '^loja\d{2}_camera\d+$') { continue }
        if ($file.Length -gt 90MB) {
            Write-UploadLog "LOCAL_ONLY camera=$camera file=$($file.Name) bytes=$($file.Length) reason=cloud_limit"
            Set-Content -LiteralPath ($file.FullName + '.uploaded') -Value 'local-only' -Encoding ASCII
            continue
        }
        try {
            $headers = @{
                'X-Agent-Token' = $token
                'X-Camera-Name' = $camera
                'X-Segment-Name' = $file.Name
                'X-Segment-Duration' = [string]$segmentSeconds
            }
            Invoke-WebRequest -UseBasicParsing -Uri $cloudUrl -Method Post -Headers $headers -ContentType 'application/octet-stream' -InFile $file.FullName -TimeoutSec 180 | Out-Null
            Set-Content -LiteralPath ($file.FullName + '.uploaded') -Value (Get-Date).ToUniversalTime().ToString('o') -Encoding ASCII
            Write-UploadLog "UPLOADED camera=$camera file=$($file.Name) bytes=$($file.Length)"
        } catch {
            Write-UploadLog "RETRY camera=$camera file=$($file.Name) error=$($_.Exception.Message)"
            break
        }
    }
} catch {
    Write-UploadLog "WORKER_FAILED error=$($_.Exception.Message)"
    exit 1
}

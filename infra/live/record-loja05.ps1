param(
    [string]$ConfigPath = 'C:\TenisCash\CameraAgent\camera-config.json'
)

$ErrorActionPreference = 'Stop'
$root = 'C:\TenisCash\CameraAgent'
$recordRoot = Join-Path $root 'recordings_clean'
$ffmpeg = Join-Path $root 'ffmpeg.exe'
$agentEnv = 'C:\TenisCashAgent\.env'
$logFile = Join-Path $root 'recorder.log'
$uploadLog = Join-Path $root 'upload.log'
$cloudUrl = 'https://www.teniscash.com.br/api/auth/agent-camera-segment'
$retentionHours = 72
$localMaxBytes = 320GB
$segmentSeconds = 120

function Write-RecorderLog([string]$message) {
    $line = '[{0}] {1}' -f (Get-Date).ToUniversalTime().ToString('o'), $message
    Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}

function Write-UploadLog([string]$message) {
    $line = '[{0}] {1}' -f (Get-Date).ToUniversalTime().ToString('o'), $message
    Add-Content -LiteralPath $uploadLog -Value $line -Encoding UTF8
}

if (-not (Test-Path -LiteralPath $ffmpeg)) { throw 'FFmpeg not found.' }
if (-not (Test-Path -LiteralPath $ConfigPath)) { throw 'Camera configuration not found.' }
$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
New-Item -ItemType Directory -Path $recordRoot -Force | Out-Null

$processes = @{}

function Start-CameraRecorder($camera) {
    $cameraDir = Join-Path $recordRoot $camera.name
    New-Item -ItemType Directory -Path $cameraDir -Force | Out-Null
    $pattern = Join-Path $cameraDir '%Y-%m-%d_%H-%M-%S.mp4'
    $stderr = Join-Path $root ($camera.name + '-ffmpeg.log')
    $inputArguments = if ($camera.source -like 'http*') {
        @('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-live_start_index', '-1')
    } else {
        @('-rtsp_transport', 'tcp', '-fflags', '+genpts+discardcorrupt', '-use_wallclock_as_timestamps', '1')
    }
    $arguments = @(
        '-hide_banner', '-nostdin', '-loglevel', 'warning'
    ) + $inputArguments + @(
        '-i', $camera.source,
        '-map', '0:v:0', '-an', '-c:v', 'copy',
        '-avoid_negative_ts', 'make_zero',
        '-f', 'segment', '-segment_time', [string]$segmentSeconds,
        '-segment_atclocktime', '1', '-reset_timestamps', '1', '-strftime', '1',
        '-segment_format_options', 'movflags=+faststart',
        $pattern
    )
    $process = Start-Process -FilePath $ffmpeg -ArgumentList $arguments -WindowStyle Hidden -RedirectStandardError $stderr -PassThru
    $processes[$camera.name] = $process
    Write-RecorderLog "START camera=$($camera.name) pid=$($process.Id)"
}

function Get-AgentToken {
    if (-not (Test-Path -LiteralPath $agentEnv)) { return $null }
    $line = Get-Content -LiteralPath $agentEnv | Where-Object { $_ -match '^AGENT_TOKEN=' } | Select-Object -First 1
    if (-not $line) { return $null }
    $token = ($line -replace '^AGENT_TOKEN=', '').Trim().Trim('"').Trim("'")
    if ($token.Length -lt 16) { return $null }
    return $token
}

function Send-CompletedSegments {
    $token = Get-AgentToken
    if (-not $token) { return }
    $readyBefore = (Get-Date).AddMinutes(-3)
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
}

function Remove-ExpiredSegments {
    $cutoff = (Get-Date).AddHours(-$retentionHours)
    Get-ChildItem -LiteralPath $recordRoot -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt $cutoff } |
        Remove-Item -Force -ErrorAction SilentlyContinue

    $segments = Get-ChildItem -LiteralPath $recordRoot -Recurse -File -Filter '*.mp4' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime
    $total = ($segments | Measure-Object Length -Sum).Sum
    foreach ($segment in $segments) {
        if ($total -le $localMaxBytes) { break }
        $bytes = $segment.Length
        Remove-Item -LiteralPath $segment.FullName -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath ($segment.FullName + '.uploaded') -Force -ErrorAction SilentlyContinue
        $total -= $bytes
    }
}

try {
    foreach ($camera in $config.cameras) { Start-CameraRecorder $camera }
    $lastMaintenance = Get-Date '2000-01-01'
    while ($true) {
        Start-Sleep -Seconds 20
        foreach ($camera in $config.cameras) {
            $process = $processes[$camera.name]
            if (-not $process -or $process.HasExited) {
                $exitCode = if ($process) { $process.ExitCode } else { 'missing' }
                Write-RecorderLog "RESTART camera=$($camera.name) exit=$exitCode"
                Start-CameraRecorder $camera
            }
        }
        if ((Get-Date) -gt $lastMaintenance.AddMinutes(1)) {
            Send-CompletedSegments
            Remove-ExpiredSegments
            $lastMaintenance = Get-Date
        }
    }
} finally {
    foreach ($process in $processes.Values) {
        try { if (-not $process.HasExited) { $process.Kill() } } catch {}
    }
}

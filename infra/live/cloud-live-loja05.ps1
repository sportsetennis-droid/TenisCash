param(
    [string]$ConfigPath = 'C:\TenisCash\CameraAgent\camera-config.json'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = 'C:\TenisCash\CameraAgent'
$liveRoot = Join-Path $root 'live_cloud'
$ffmpeg = Join-Path $root 'ffmpeg.exe'
$agentEnv = 'C:\TenisCashAgent\.env'
$cloudUrl = 'https://www.teniscash.com.br/api/auth/agent-camera-live'
$logFile = Join-Path $root 'cloud-live.log'

function Write-LiveLog([string]$message) {
    $line = '[{0}] {1}' -f (Get-Date).ToUniversalTime().ToString('o'), $message
    Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}

function Get-AgentToken {
    if (-not (Test-Path -LiteralPath $agentEnv)) { return $null }
    $line = Get-Content -LiteralPath $agentEnv | Where-Object { $_ -match '^AGENT_TOKEN=' } | Select-Object -First 1
    if (-not $line) { return $null }
    $value = ($line -replace '^AGENT_TOKEN=', '').Trim().Trim('"').Trim("'")
    if ($value.Length -lt 16) { return $null }
    return $value
}

if (-not (Test-Path -LiteralPath $ffmpeg)) { throw 'FFmpeg not found.' }
if (-not (Test-Path -LiteralPath $ConfigPath)) { throw 'Camera configuration not found.' }
$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$token = Get-AgentToken
if (-not $token) { throw 'Agent credential not found.' }
New-Item -ItemType Directory -Path $liveRoot -Force | Out-Null

$processes = @{}
$playlistHashes = @{}

function Start-CameraLive($camera) {
    $cameraDir = Join-Path $liveRoot $camera.name
    New-Item -ItemType Directory -Path $cameraDir -Force | Out-Null
    Get-ChildItem -LiteralPath $cameraDir -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    $playlist = Join-Path $cameraDir 'index.m3u8'
    $segmentPattern = Join-Path $cameraDir '%Y%m%dT%H%M%S_%%04d.ts'
    $stderr = Join-Path $root ($camera.name + '-cloud-live-ffmpeg.log')
    $arguments = @(
        '-hide_banner', '-nostdin', '-loglevel', 'warning',
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
        '-live_start_index', '-1', '-i', $camera.source,
        '-map', '0:v:0', '-an', '-c:v', 'copy',
        '-f', 'hls', '-hls_time', '4', '-hls_list_size', '8',
        '-hls_segment_type', 'mpegts',
        '-hls_flags', 'delete_segments+independent_segments+omit_endlist+temp_file+second_level_segment_index',
        '-strftime', '1', '-hls_segment_filename', $segmentPattern,
        $playlist
    )
    $process = Start-Process -FilePath $ffmpeg -ArgumentList $arguments -WindowStyle Hidden -RedirectStandardError $stderr -PassThru
    $processes[$camera.name] = $process
    $playlistHashes.Remove($camera.name)
    Write-LiveLog "START camera=$($camera.name) pid=$($process.Id)"
}

function Send-LiveFile([string]$camera, [IO.FileInfo]$file) {
    $headers = @{
        'X-Agent-Token' = $token
        'X-Camera-Name' = $camera
        'X-Live-File-Name' = $file.Name
    }
    Invoke-WebRequest -UseBasicParsing -Uri $cloudUrl -Method Post -Headers $headers -ContentType 'application/octet-stream' -InFile $file.FullName -TimeoutSec 30 | Out-Null
}

function Publish-CameraLive($camera) {
    $cameraDir = Join-Path $liveRoot $camera.name
    $playlistPath = Join-Path $cameraDir 'index.m3u8'
    if (-not (Test-Path -LiteralPath $playlistPath)) { return }
    $playlistText = Get-Content -LiteralPath $playlistPath -Raw -Encoding UTF8
    $segments = @($playlistText -split "`r?`n" | Where-Object { $_ -match '^\d{8}T\d{6}(?:_\d+)?\.ts$' })
    if (-not $segments.Count) { return }

    foreach ($segmentName in $segments) {
        $segmentPath = Join-Path $cameraDir $segmentName
        $sentPath = $segmentPath + '.sent'
        if (-not (Test-Path -LiteralPath $segmentPath)) { return }
        if (-not (Test-Path -LiteralPath $sentPath)) {
            $segment = Get-Item -LiteralPath $segmentPath
            Send-LiveFile -camera $camera.name -file $segment
            Set-Content -LiteralPath $sentPath -Value (Get-Date).ToUniversalTime().ToString('o') -Encoding ASCII
        }
    }

    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $playlistPath).Hash
    if ($playlistHashes[$camera.name] -ne $hash) {
        Send-LiveFile -camera $camera.name -file (Get-Item -LiteralPath $playlistPath)
        $playlistHashes[$camera.name] = $hash
    }

    Get-ChildItem -LiteralPath $cameraDir -File -Filter '*.sent' -ErrorAction SilentlyContinue |
        Where-Object { -not (Test-Path -LiteralPath $_.FullName.Substring(0, $_.FullName.Length - 5)) } |
        Remove-Item -Force -ErrorAction SilentlyContinue
}

try {
    foreach ($camera in $config.cameras) { Start-CameraLive $camera }
    while ($true) {
        Start-Sleep -Seconds 2
        foreach ($camera in $config.cameras) {
            $process = $processes[$camera.name]
            if (-not $process -or $process.HasExited) {
                $exitCode = if ($process) { $process.ExitCode } else { 'missing' }
                Write-LiveLog "RESTART camera=$($camera.name) exit=$exitCode"
                Start-CameraLive $camera
            }
            try { Publish-CameraLive $camera } catch { Write-LiveLog "RETRY camera=$($camera.name) error=$($_.Exception.Message)" }
        }
    }
} finally {
    foreach ($process in $processes.Values) {
        try { if (-not $process.HasExited) { $process.Kill() } } catch {}
    }
}

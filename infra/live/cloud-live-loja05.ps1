param(
    [string]$ConfigPath = 'C:\TenisCash\CameraAgent\camera-config.json'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = 'C:\TenisCash\CameraAgent'
$cacheRoot = Join-Path $root 'live_cloud'
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

if (-not (Test-Path -LiteralPath $ConfigPath)) { throw 'Camera configuration not found.' }
$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$token = Get-AgentToken
if (-not $token) { throw 'Agent credential not found.' }
New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null

$playlistHashes = @{}

function Get-ResponseText($response) {
    if ($response.Content -is [byte[]]) { return [Text.Encoding]::UTF8.GetString($response.Content) }
    return [string]$response.Content
}

function Get-LatestPlaylist([string]$playlistText, [int]$keepCount = 3) {
    $lines = @($playlistText -split "`r?`n")
    $segmentIndexes = @()
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $value = $lines[$i].Trim()
        if ($value -and -not $value.StartsWith('#')) { $segmentIndexes += $i }
    }
    if ($segmentIndexes.Count -le $keepCount) { return $playlistText }

    $originalSequence = 0
    $sequenceLine = @($lines | Where-Object { $_ -match '^#EXT-X-MEDIA-SEQUENCE:(\d+)$' })[0]
    if ($sequenceLine -match '^#EXT-X-MEDIA-SEQUENCE:(\d+)$') { $originalSequence = [int64]$Matches[1] }
    $dropCount = $segmentIndexes.Count - $keepCount
    $newSequence = $originalSequence + $dropCount

    $result = [Collections.Generic.List[string]]::new()
    $firstSegmentTag = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^#EXTINF:') { $firstSegmentTag = $i; break }
    }
    if ($firstSegmentTag -lt 0) { return $playlistText }

    for ($i = 0; $i -lt $firstSegmentTag; $i++) {
        if ($lines[$i] -match '^#EXT-X-MEDIA-SEQUENCE:') {
            $result.Add("#EXT-X-MEDIA-SEQUENCE:$newSequence")
        } else {
            $result.Add($lines[$i])
        }
    }

    foreach ($uriIndex in @($segmentIndexes | Select-Object -Last $keepCount)) {
        $start = $uriIndex - 1
        while ($start -ge $firstSegmentTag -and $lines[$start].Trim().StartsWith('#')) { $start-- }
        $start++
        for ($i = $start; $i -le $uriIndex; $i++) { $result.Add($lines[$i]) }
    }

    if ($lines -contains '#EXT-X-ENDLIST') { $result.Add('#EXT-X-ENDLIST') }
    return ($result -join "`n") + "`n"
}

function Send-LiveFile([string]$camera, [IO.FileInfo]$file) {
    $headers = @{
        'X-Agent-Token' = $token
        'X-Camera-Name' = $camera
        'X-Live-File-Name' = $file.Name
    }
    Invoke-WebRequest -UseBasicParsing -Uri $cloudUrl -Method Post -Headers $headers -ContentType 'application/octet-stream' -InFile $file.FullName -TimeoutSec 45 | Out-Null
}

function Publish-CameraLive($camera) {
    $cameraDir = Join-Path $cacheRoot $camera.name
    New-Item -ItemType Directory -Path $cameraDir -Force | Out-Null
    $masterUrl = [string]$camera.source
    $master = Invoke-WebRequest -UseBasicParsing -Uri $masterUrl -SessionVariable cameraSession -TimeoutSec 15
    $masterText = Get-ResponseText $master
    $variant = @($masterText -split "`r?`n" | Where-Object { $_ -and -not $_.StartsWith('#') })[0].Trim()
    if (-not $variant) { throw 'Playlist da câmera sem variante de vídeo.' }
    $variantUrl = [Uri]::new([Uri]$masterUrl, $variant).AbsoluteUri
    $media = Invoke-WebRequest -UseBasicParsing -Uri $variantUrl -WebSession $cameraSession -TimeoutSec 15
    $playlistText = Get-LatestPlaylist -playlistText (Get-ResponseText $media) -keepCount 3

    $resourceNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($line in ($playlistText -split "`r?`n")) {
        $value = $line.Trim()
        if ($value -match '^#EXT-X-MAP:.*URI="([^"]+)"') { [void]$resourceNames.Add($Matches[1]) }
        elseif ($value -and -not $value.StartsWith('#')) { [void]$resourceNames.Add($value) }
    }
    if (-not $resourceNames.Count) { throw 'Playlist da câmera sem fragmentos.' }

    foreach ($resourceName in $resourceNames) {
        $safeName = [IO.Path]::GetFileName(([string]$resourceName -split '\?')[0])
        if ($safeName -notmatch '^[A-Fa-f0-9]+_video\d+_(?:init|seg\d+)\.mp4$') { throw 'Nome de fragmento inválido.' }
        $filePath = Join-Path $cameraDir $safeName
        $sentPath = $filePath + '.sent'
        $refreshInit = $safeName -match '_init\.mp4$' -and
            (Test-Path -LiteralPath $sentPath) -and
            (Get-Item -LiteralPath $sentPath).LastWriteTime -lt (Get-Date).AddMinutes(-5)
        if (-not (Test-Path -LiteralPath $sentPath) -or $refreshInit) {
            if (-not (Test-Path -LiteralPath $filePath)) {
                $resourceUrl = [Uri]::new([Uri]$variantUrl, [string]$resourceName).AbsoluteUri
                $tempPath = $filePath + '.tmp'
                Invoke-WebRequest -UseBasicParsing -Uri $resourceUrl -WebSession $cameraSession -OutFile $tempPath -TimeoutSec 30
                Move-Item -LiteralPath $tempPath -Destination $filePath -Force
            }
            Send-LiveFile -camera $camera.name -file (Get-Item -LiteralPath $filePath)
            Set-Content -LiteralPath $sentPath -Value (Get-Date).ToUniversalTime().ToString('o') -Encoding ASCII
        }
    }

    $playlistPath = Join-Path $cameraDir 'index.m3u8'
    [IO.File]::WriteAllText($playlistPath, $playlistText, [Text.UTF8Encoding]::new($false))
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $playlistPath).Hash
    if ($playlistHashes[$camera.name] -ne $hash) {
        Send-LiveFile -camera $camera.name -file (Get-Item -LiteralPath $playlistPath)
        $playlistHashes[$camera.name] = $hash
    }

    $cutoff = (Get-Date).AddMinutes(-20)
    Get-ChildItem -LiteralPath $cameraDir -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ne 'index.m3u8' -and $_.LastWriteTime -lt $cutoff } |
        Remove-Item -Force -ErrorAction SilentlyContinue
}

Write-LiveLog 'START direct_fmp4_cloud_relay'
while ($true) {
    foreach ($camera in $config.cameras) {
        try { Publish-CameraLive $camera } catch { Write-LiveLog "RETRY camera=$($camera.name) error=$($_.Exception.Message)" }
    }
    Start-Sleep -Seconds 1
}

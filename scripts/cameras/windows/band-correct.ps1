param(
    [string]$StoreCode = 'loja05',
    [int[]]$Cameras = @(1, 2, 3, 4, 5, 6),
    [string]$Root = 'C:\TenisCash\CameraAgent'
)

$ErrorActionPreference = 'Stop'
$store = $StoreCode.Trim().ToLowerInvariant()
$ffmpeg = Join-Path $Root 'ffmpeg.exe'
$logFile = Join-Path $Root "$store-band-correct.log"
$children = @{}

function Write-BandLog([string]$Message) {
    $line = '[{0}] {1}' -f (Get-Date).ToUniversalTime().ToString('o'), $Message
    try {
        Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8 -ErrorAction Stop
    } catch {
        # Logging must never interrupt the live feed.
    }
}

function Stop-StalePublishers {
    $pattern = [regex]::Escape($store) + '_camera\d+_fixed'
    Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -match $pattern -and
            $_.CommandLine -match 'rtsp://127\.0\.0\.1:8554/'
        } |
        ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
}

function Start-Camera([int]$Camera) {
    $cameraName = "${store}_camera$Camera"
    $inputUrl = "http://127.0.0.1:8888/$cameraName/index.m3u8"
    $outputUrl = "rtsp://127.0.0.1:8554/${cameraName}_fixed"
    $stderrPath = Join-Path $Root "$cameraName-band.err.log"
    $stdoutPath = Join-Path $Root "$cameraName-band.out.log"

    # Estimate one illumination value per image row, remove the rolling LED
    # component, and preserve the original pixels and chroma information.
    $filter = @(
        '[0:v]fps=8,scale=1920:1080:flags=lanczos,format=yuv420p,split=2[orig][rows]'
        '[rows]scale=1:1080:flags=area,split=2[rowcur][rowbase]'
        '[rowcur]avgblur=sizeX=1:sizeY=9,scale=1920:1080:flags=neighbor[curmap]'
        '[rowbase]avgblur=sizeX=1:sizeY=251,scale=1920:1080:flags=neighbor[basemap]'
        '[basemap][curmap]lut2=c0=clip(32*pow(x/max(y\,1)\,0.90)\,20\,64):c1=32:c2=32[gainmap]'
        '[orig][gainmap]lut2=c0=clip(x*y/32\,0\,255):c1=x:c2=x,format=nv12[out]'
    ) -join ';'

    $arguments = @(
        '-hide_banner',
        '-nostdin',
        '-loglevel', 'warning',
        '-fflags', '+genpts+discardcorrupt',
        '-threads', '2',
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '2',
        '-i', $inputUrl,
        '-filter_complex', $filter,
        '-map', '[out]',
        '-an',
        '-c:v', 'h264_qsv',
        '-preset', 'veryfast',
        '-look_ahead', '0',
        '-b:v', '2M',
        '-maxrate', '2500k',
        '-bufsize', '4M',
        '-g', '16',
        '-bf', '0',
        '-f', 'rtsp',
        '-rtsp_transport', 'tcp',
        $outputUrl
    )

    $process = Start-Process `
        -FilePath $ffmpeg `
        -ArgumentList $arguments `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -WindowStyle Hidden `
        -PassThru
    $children[$Camera] = $process
    Write-BandLog "START camera=$Camera pid=$($process.Id)"
}

if (-not (Test-Path -LiteralPath $ffmpeg)) { throw 'FFmpeg not found.' }
Stop-StalePublishers
Write-BandLog "START supervisor store=$store cameras=$($Cameras -join ',')"

try {
    while ($true) {
        foreach ($camera in $Cameras) {
            $process = $children[$camera]
            if ($null -eq $process -or $process.HasExited) {
                if ($null -ne $process) {
                    Write-BandLog "EXIT camera=$camera code=$($process.ExitCode)"
                }
                try {
                    Start-Camera $camera
                } catch {
                    Write-BandLog "RETRY camera=$camera error=$($_.Exception.Message)"
                }
            }
        }
        Start-Sleep -Seconds 3
    }
} finally {
    foreach ($process in $children.Values) {
        if ($null -ne $process -and -not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
    }
    Write-BandLog 'STOP supervisor'
}

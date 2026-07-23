param(
    [Parameter(Mandatory = $true)]
    [string]$CameraUsername,

    [Parameter(Mandatory = $true)]
    [string]$CameraPassword
)

$ErrorActionPreference = 'Stop'
$root = 'C:\TenisCash\CameraAgent'
$version = '1.19.2'
$asset = "mediamtx_v${version}_windows_amd64.zip"
$download = "https://github.com/bluenviron/mediamtx/releases/download/v${version}/$asset"
$checksumsUrl = "https://github.com/bluenviron/mediamtx/releases/download/v${version}/checksums.sha256"

New-Item -ItemType Directory -Path $root -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $root 'recordings') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $root 'recordings_clean') -Force | Out-Null

$zip = Join-Path $root $asset
$checksums = Join-Path $root 'checksums.sha256'
Invoke-WebRequest -UseBasicParsing -Uri $download -OutFile $zip
Invoke-WebRequest -UseBasicParsing -Uri $checksumsUrl -OutFile $checksums

$expectedLine = Get-Content -LiteralPath $checksums | Where-Object { $_ -match [regex]::Escape($asset) } | Select-Object -First 1
if (-not $expectedLine) { throw 'Checksum oficial do MediaMTX não encontrado.' }
$expected = ($expectedLine -split '\s+')[0].ToLowerInvariant()
$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
if ($expected -ne $actual) { throw 'Checksum do MediaMTX não confere.' }

Expand-Archive -LiteralPath $zip -DestinationPath $root -Force

$template = Join-Path $PSScriptRoot 'mediamtx-loja05.yml.template'
$uploader = Join-Path $PSScriptRoot 'upload-segment.ps1'
$recorder = Join-Path $PSScriptRoot 'record-loja05.ps1'
$recordingUploader = Join-Path $PSScriptRoot 'upload-recordings.ps1'
$cloudLive = Join-Path $PSScriptRoot 'cloud-live-loja05.ps1'
$bandCorrection = Join-Path $PSScriptRoot 'correct-horizontal-bands.py'
if (-not (Test-Path -LiteralPath $template)) { throw 'Template do gravador não encontrado.' }
if (-not (Test-Path -LiteralPath $uploader)) { throw 'Uploader do gravador não encontrado.' }

$encodedUser = [Uri]::EscapeDataString($CameraUsername)
$encodedPassword = [Uri]::EscapeDataString($CameraPassword)
$config = (Get-Content -LiteralPath $template -Raw -Encoding UTF8).
    Replace('__RTSP_USER__', $encodedUser).
    Replace('__RTSP_PASSWORD__', $encodedPassword)
$configPath = Join-Path $root 'mediamtx.yml'
[IO.File]::WriteAllText($configPath, $config, [Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath $uploader -Destination (Join-Path $root 'upload-segment.ps1') -Force
Copy-Item -LiteralPath $recorder -Destination (Join-Path $root 'record-loja05.ps1') -Force
Copy-Item -LiteralPath $recordingUploader -Destination (Join-Path $root 'upload-recordings.ps1') -Force
Copy-Item -LiteralPath $cloudLive -Destination (Join-Path $root 'cloud-live-loja05.ps1') -Force
if (-not (Test-Path -LiteralPath $bandCorrection)) { throw 'Corretor de imagem nao encontrado.' }
Copy-Item -LiteralPath $bandCorrection -Destination (Join-Path $root 'correct-horizontal-bands.py') -Force

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    winget install --id Gyan.FFmpeg --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
}
$ffmpegSource = (Get-Command ffmpeg -ErrorAction Stop).Source
Copy-Item -LiteralPath $ffmpegSource -Destination (Join-Path $root 'ffmpeg.exe') -Force

$python = Join-Path $env:LocalAppData 'Programs\Python\Python312\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
    winget install --id Python.Python.3.12 --exact --silent --scope user --accept-package-agreements --accept-source-agreements --disable-interactivity
}
if (-not (Test-Path -LiteralPath $python)) { throw 'Python 3.12 nao foi instalado.' }
& $python -m pip install --disable-pip-version-check --quiet 'opencv-python-headless>=4.10,<6'
if ($LASTEXITCODE -ne 0) { throw 'OpenCV nao foi instalado.' }

$cameraConfig = @{
    cameras = @(
        @{ name = 'loja05_camera1'; source = 'http://127.0.0.1:8888/loja05_camera1_fixed/index.m3u8' },
        @{ name = 'loja05_camera2'; source = 'http://127.0.0.1:8888/loja05_camera2_fixed/index.m3u8' },
        @{ name = 'loja05_camera3'; source = 'http://127.0.0.1:8888/loja05_camera3_fixed/index.m3u8' },
        @{ name = 'loja05_camera4'; source = 'http://127.0.0.1:8888/loja05_camera4_fixed/index.m3u8' },
        @{ name = 'loja05_camera5'; source = 'http://127.0.0.1:8888/loja05_camera5_fixed/index.m3u8' },
        @{ name = 'loja05_camera6'; source = 'http://127.0.0.1:8888/loja05_camera6_fixed/index.m3u8' }
    )
} | ConvertTo-Json -Depth 4
$cameraConfigPath = Join-Path $root 'camera-config.json'
[IO.File]::WriteAllText($cameraConfigPath, $cameraConfig, [Text.UTF8Encoding]::new($false))

$taskName = 'TenisCashCameraAgent'
try { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue } catch {}
try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}

$action = New-ScheduledTaskAction -Execute (Join-Path $root 'mediamtx.exe') -Argument ('"{0}"' -f $configPath) -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 20 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

$bandTaskName = 'TenisCashCameraBandCorrection'
try { Stop-ScheduledTask -TaskName $bandTaskName -ErrorAction SilentlyContinue } catch {}
try { Unregister-ScheduledTask -TaskName $bandTaskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
$bandScript = Join-Path $root 'correct-horizontal-bands.py'
$bandArguments = ('-u "{0}" --store-prefix loja05 --camera-count 6 --ffmpeg "{1}" --encoder h264_mf' -f $bandScript, (Join-Path $root 'ffmpeg.exe'))
$bandAction = New-ScheduledTaskAction -Execute $python -Argument $bandArguments -WorkingDirectory $root
$bandSettings = New-ScheduledTaskSettingsSet -RestartCount 20 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $bandTaskName -Action $bandAction -Trigger $trigger -Principal $principal -Settings $bandSettings -Force | Out-Null
Start-ScheduledTask -TaskName $bandTaskName

$recorderTaskName = 'TenisCashCameraRecorder'
try { Stop-ScheduledTask -TaskName $recorderTaskName -ErrorAction SilentlyContinue } catch {}
try { Unregister-ScheduledTask -TaskName $recorderTaskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
$recorderAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f (Join-Path $root 'record-loja05.ps1')) -WorkingDirectory $root
$recorderSettings = New-ScheduledTaskSettingsSet -RestartCount 20 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $recorderTaskName -Action $recorderAction -Trigger $trigger -Principal $principal -Settings $recorderSettings -Force | Out-Null
Start-ScheduledTask -TaskName $recorderTaskName

$cloudLiveTaskName = 'TenisCashCameraCloudLive'
try { Stop-ScheduledTask -TaskName $cloudLiveTaskName -ErrorAction SilentlyContinue } catch {}
try { Unregister-ScheduledTask -TaskName $cloudLiveTaskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
$cloudLiveAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f (Join-Path $root 'cloud-live-loja05.ps1')) -WorkingDirectory $root
$cloudLiveSettings = New-ScheduledTaskSettingsSet -RestartCount 20 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $cloudLiveTaskName -Action $cloudLiveAction -Trigger $trigger -Principal $principal -Settings $cloudLiveSettings -Force | Out-Null
Start-ScheduledTask -TaskName $cloudLiveTaskName

Get-NetFirewallRule -DisplayName 'TenisCash Câmeras HLS' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Get-NetFirewallRule -DisplayName 'TenisCash Câmeras Playback' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'TenisCash Câmeras HLS' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8888 -RemoteAddress 100.64.0.0/10 -Profile Any | Out-Null
New-NetFirewallRule -DisplayName 'TenisCash Câmeras Playback' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 9996 -RemoteAddress 100.64.0.0/10 -Profile Any | Out-Null

$tailscale = 'C:\Program Files\Tailscale\tailscale.exe'
& $tailscale serve --bg --yes --https=443 http://127.0.0.1:8888 | Out-Null
& $tailscale serve --bg --yes --https=8443 http://127.0.0.1:9996 | Out-Null

Start-Sleep -Seconds 8
$task = Get-ScheduledTask -TaskName $taskName
$listeners = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object LocalPort -in 8888,9996
[pscustomobject]@{
    TaskState = $task.State
    HLS = [bool]($listeners | Where-Object LocalPort -eq 8888)
    Playback = [bool]($listeners | Where-Object LocalPort -eq 9996)
    RecorderState = (Get-ScheduledTask -TaskName $recorderTaskName).State.ToString()
    CloudLiveState = (Get-ScheduledTask -TaskName $cloudLiveTaskName).State.ToString()
    BandCorrectionState = (Get-ScheduledTask -TaskName $bandTaskName).State.ToString()
    Version = $version
} | ConvertTo-Json -Compress

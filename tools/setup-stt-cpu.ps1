param(
    [string]$Root = 'D:\Apps\实时会议助手-STT-CPU',
    [string]$Python = '3.12',
    [int]$Threads = 2
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$Root = [IO.Path]::GetFullPath($Root)
if ($Root -eq $repo -or $Root.StartsWith($repo + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Use an independent runtime directory outside the source checkout.'
}
if ($Threads -lt 1) { throw 'Threads must be positive' }
New-Item -ItemType Directory -Path $Root -Force | Out-Null
$pythonExe = Join-Path $Root '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonExe)) {
    & uv venv --python $Python (Join-Path $Root '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Unable to create the isolated Python environment' }
}
& uv pip install --python $pythonExe --cache-dir (Join-Path $Root 'cache') -r (Join-Path $repo 'services\stt-worker\requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'CPU runtime installation failed' }
& $pythonExe -X utf8 (Join-Path $repo 'tools\download_stt_cpu.py') --root $Root
if ($LASTEXITCODE -ne 0) { throw 'Pinned model download or integrity verification failed' }
$service = Join-Path $Root 'service'
New-Item -ItemType Directory -Path $service -Force | Out-Null
foreach ($name in @('stt_worker.py', 'requirements.txt', 'cpu-model.json')) {
    Copy-Item -LiteralPath (Join-Path $repo ('services\stt-worker\' + $name)) -Destination (Join-Path $service $name)
}
Copy-Item -LiteralPath (Join-Path $repo 'services\stt-worker\start-cpu.ps1') -Destination (Join-Path $Root 'start-cpu.ps1')
$settingsPath = Join-Path $Root 'stt-cpu.json'
if (-not (Test-Path -LiteralPath $settingsPath)) {
    [ordered]@{ provider='cpu'; threads=$Threads; modelDir='models\sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20' } | ConvertTo-Json | Set-Content -LiteralPath $settingsPath -Encoding utf8
}
# The launcher stays in the foreground. The desktop does not own or stop this manually started service.
@'
@echo off
powershell.exe -NoProfile -File "%~dp0start-cpu.ps1"
if errorlevel 1 pause
'@ | Set-Content -LiteralPath (Join-Path $Root 'Start-CPU-STT.bat') -Encoding ascii
Copy-Item -LiteralPath (Join-Path $Root 'Start-CPU-STT.bat') -Destination (Join-Path $Root '启动CPU语音服务.bat')
Copy-Item -LiteralPath (Join-Path $repo 'docs\STT_CPU.md') -Destination (Join-Path $Root '使用说明.md')
Write-Host "CPU STT is ready at $Root"
Write-Host "Run: powershell -NoProfile -File `"$Root\start-cpu.ps1`""

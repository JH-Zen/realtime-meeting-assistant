param(
    [string]$Root = $PSScriptRoot,
    [int]$Port = 6006,
    [int]$Threads = 0
)
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath($Root)
$settings = Get-Content -LiteralPath (Join-Path $Root 'stt-cpu.json') -Raw -Encoding utf8 | ConvertFrom-Json
if ($Threads -eq 0) { $Threads = $settings.threads }
if ($Threads -lt 1 -or $Port -lt 1 -or $Port -gt 65535) { throw 'Invalid thread count or port' }
$python = Join-Path $Root '.venv\Scripts\python.exe'
$worker = Join-Path $Root 'service\stt_worker.py'
$model = Join-Path $Root $settings.modelDir
foreach ($path in @($python, $worker, (Join-Path $model 'tokens.txt'))) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Missing STT file: $path. Run setup-stt-cpu.ps1 first." }
}
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
    throw "Port $Port is already in use. No existing process was changed. Choose another port with -Port."
}
$logs = Join-Path $Root 'logs'
New-Item -ItemType Directory -Path $logs -Force | Out-Null
$log = Join-Path $logs ('worker-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
Write-Host 'CPU 语音服务。录音期间请保留此窗口；按 Ctrl+C 停止服务。'
Write-Host "模型：$model"
Write-Host "地址：ws://127.0.0.1:$Port   CPU 线程：$Threads"
Write-Host "日志：$log"
$previousUtf8 = $env:PYTHONUTF8
$env:PYTHONUTF8 = '1'
try {
    & $python -u $worker --host 127.0.0.1 --port $Port --model-dir $model --num-threads $Threads --decoding-method greedy_search 2>&1 | Tee-Object -FilePath $log
    if ($LASTEXITCODE -ne 0) { throw "STT service exited with code $LASTEXITCODE; see $log" }
} finally { $env:PYTHONUTF8 = $previousUtf8 }

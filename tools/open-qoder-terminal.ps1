param(
    [string]$TaskDir = 'D:\AI Workspace\Qoder Tasks\实时会议助手\index-recovery-preview6',
    [switch]$InCurrentWindow,
    [switch]$RunTask
)
$ErrorActionPreference = 'Stop'
$TaskDir = (Resolve-Path -LiteralPath $TaskDir).Path
$QoderCli = Join-Path $env:USERPROFILE '.qoder\bin\qodercli\qodercli.exe'
if (!(Test-Path -LiteralPath $QoderCli -PathType Leaf)) { throw "Qoder CLI is missing: $QoderCli" }
foreach ($Required in @('TASK.md', 'task-manifest.json')) {
    if (!(Test-Path -LiteralPath (Join-Path $TaskDir $Required) -PathType Leaf)) { throw "Not a prepared task copy: $TaskDir" }
}
foreach ($Excluded in @('.env', '.git')) {
    if (Test-Path -LiteralPath (Join-Path $TaskDir $Excluded)) { throw 'Use an independent task copy without .env or .git.' }
}
if (!$InCurrentWindow) {
    $TaskShell = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
    if (!$TaskShell) { $TaskShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe' }
    # Windows cannot contain a quote in a resolved path. Quote each path for Start-Process's argv join.
    $TaskArgs = @('-NoLogo', '-NoProfile', '-NoExit', '-File', ('"' + $PSCommandPath + '"'), '-TaskDir', ('"' + $TaskDir + '"'), '-InCurrentWindow')
    if ($RunTask) { $TaskArgs += '-RunTask' }
    $TaskProcess = Start-Process -FilePath $TaskShell -ArgumentList $TaskArgs -WorkingDirectory $TaskDir -WindowStyle Normal -PassThru
    [pscustomobject]@{ processId = $TaskProcess.Id; task = $TaskDir; interactive = $true } | ConvertTo-Json -Compress
    return
}
$Host.UI.RawUI.WindowTitle = 'Qoder - Meeting Assistant - DeepSeek-Flash'
Write-Host ('Task: ' + $TaskDir)
Write-Host 'Model: DeepSeek-Flash (built-in platform model)'
Write-Host 'Interactive session. Read/Edit/Write/Glob/Grep are enabled; shell, network and MCP tools are excluded.'
$ReportFile = Join-Path $TaskDir 'qoder-result.json'
if (Test-Path -LiteralPath $ReportFile) {
    $TaskReport = Get-Content -LiteralPath $ReportFile -Raw -Encoding UTF8 | ConvertFrom-Json
    Write-Host ('Previous task exit: ' + $TaskReport.exitCode)
    Write-Host $TaskReport.result
}
Set-Location -LiteralPath $TaskDir
$EmptyMcpConfig = Join-Path $TaskDir 'qoder-empty-mcp.json'
[System.IO.File]::WriteAllText($EmptyMcpConfig, '{"mcpServers":{}}', (New-Object System.Text.UTF8Encoding($false)))
$TaskCliArgs = @('--cwd', $TaskDir, '--model', 'DeepSeek-Flash', '--context-window', '1000000', '--reasoning-effort', 'max', '--permission-mode', 'accept_edits', '--tools', 'Read', 'Edit', 'Write', 'Glob', 'Grep', '--allowed-tools', 'Read,Edit,Write,Glob,Grep', '--strict-mcp-config', '--mcp-config', $EmptyMcpConfig)
if ($RunTask) { $TaskCliArgs += @('--prompt-interactive', (Get-Content -LiteralPath (Join-Path $TaskDir 'TASK.md') -Raw -Encoding UTF8)) }
& $QoderCli @TaskCliArgs
Write-Host ('Qoder exited: ' + $LASTEXITCODE)

param(
    [string]$Root = 'D:\Apps\实时会议助手-STT-CPU',
    [string]$Config = (Join-Path $env:LOCALAPPDATA 'RCC-Desktop-Preview\.env'),
    [int]$Port = 6006
)
$ErrorActionPreference = 'Stop'
if ($Port -lt 1 -or $Port -gt 65535) { throw 'Invalid STT port' }
if (-not (Test-Path -LiteralPath (Join-Path $Root 'stt-cpu.json'))) { throw 'Set up the CPU service first' }
if (-not (Test-Path -LiteralPath $Config)) { throw "Start the desktop preview once to create its configuration: $Config" }
$backups = Join-Path $Root 'backups'
New-Item -ItemType Directory -Path $backups -Force | Out-Null
$backup = Join-Path $backups ('desktop-env-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.env')
Copy-Item -LiteralPath $Config -Destination $backup
$text = [IO.File]::ReadAllText($Config, [Text.Encoding]::UTF8)
foreach ($entry in @(@('MOCK_STT', 'false'), @('STT_WS_URL', "ws://127.0.0.1:$Port"), @('STT_SAMPLE_RATE', '16000'))) {
    $pattern = '(?m)^[ \t]*(?:export[ \t]+)?' + [regex]::Escape($entry[0]) + '[ \t]*=[^\r\n]*'
    $line = $entry[0] + '=' + $entry[1]
    if ([regex]::IsMatch($text, $pattern)) { $text = [regex]::Replace($text, $pattern, $line) }
    else { $text = $text.TrimEnd() + "`r`n" + $line + "`r`n" }
}
[IO.File]::WriteAllText($Config, $text, (New-Object Text.UTF8Encoding($false)))
Write-Host "Desktop STT configuration updated: $Config"
Write-Host "Previous configuration: $backup"
Write-Host 'Start the CPU service, then restart the desktop preview. Other model settings were preserved.'

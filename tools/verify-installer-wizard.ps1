param([Parameter(Mandatory=$true)][string]$Installer, [Parameter(Mandatory=$true)][string]$Work, [Parameter(Mandatory=$true)][string]$Version, [Parameter(Mandatory=$true)][string]$Shortcut)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$taskSource = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'installer\WizardRegression.cs'), [Text.Encoding]::UTF8)
Add-Type -TypeDefinition $taskSource -ReferencedAssemblies System.Windows.Forms,System.Drawing
try { $taskChecks = [WizardRegression]::Run($Installer, $Work, $Version, $Shortcut) }
catch { [Console]::Error.WriteLine($_.Exception.InnerException.ToString()); exit 1 }
@{ok=$true;checks=@($taskChecks);version=$Version} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $Work 'wizard-ui.json') -Encoding UTF8
$taskChecks | ForEach-Object { Write-Output $_ }

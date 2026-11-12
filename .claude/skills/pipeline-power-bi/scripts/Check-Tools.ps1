<#
.SYNOPSIS
  Step 0 of pipeline-power-bi: checks the programs the skill needs, in one call, and prints JSON. Installs
  nothing and changes nothing.

  powershell -NoProfile -ExecutionPolicy Bypass -File .claude\skills\pipeline-power-bi\scripts\Check-Tools.ps1 [-Catalog]

  -Catalog  also check Python 3 with openpyxl (only the data catalog needs it)

  Output: node, reportCli, desktop (installed, how found, running, unsavedTitle), python, freeMemoryGB,
  and missing[] with the install command for each missing program.
#>
[CmdletBinding()]
param([switch]$Catalog)

$ErrorActionPreference = 'SilentlyContinue'
function Get-Version([string]$exe, [string[]]$argList) {
    if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { return $null }
    $v = (& $exe @argList 2>$null | Select-Object -First 1)
    if ($v) { return ([string]$v).Trim() } else { return 'found' }
}

$out = [ordered]@{}
$missing = New-Object System.Collections.Generic.List[object]

$node = Get-Version 'node' @('--version')
$out.node = $node
if (-not $node) { $missing.Add([ordered]@{ program = 'Node.js 18+'; install = 'winget install --id OpenJS.NodeJS.LTS -e' }) }
elseif ([int](($node -replace '^v', '') -split '\.')[0] -lt 18) { $missing.Add([ordered]@{ program = "Node.js 18+ (found $node)"; install = 'winget install --id OpenJS.NodeJS.LTS -e' }) }

$cli = Get-Version 'powerbi-report-author' @('--version')
$out.reportCli = $cli
if (-not $cli) { $missing.Add([ordered]@{ program = 'Power BI report CLI'; install = 'npm install -g @microsoft/powerbi-report-authoring-cli' }) }

# Desktop: Get-Command is quick; Get-AppxPackage (Store version) is slow, so only when the first finds nothing
$desk = [ordered]@{ installed = $false; how = $null; running = $false; unsavedTitle = $null }
if (Get-Command PBIDesktop -ErrorAction SilentlyContinue) { $desk.installed = $true; $desk.how = 'PATH' }
elseif (Test-Path "$env:ProgramFiles\Microsoft Power BI Desktop\bin\PBIDesktop.exe") { $desk.installed = $true; $desk.how = 'Program Files' }
elseif (Get-AppxPackage -Name '*PowerBI*' -ErrorAction SilentlyContinue) { $desk.installed = $true; $desk.how = 'Microsoft Store' }
$proc = Get-Process PBIDesktop -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1
if ($proc) { $desk.running = $true; if ($proc.MainWindowTitle -match '^\*') { $desk.unsavedTitle = $proc.MainWindowTitle } }
$out.desktop = $desk
if (-not $desk.installed) { $missing.Add([ordered]@{ program = 'Power BI Desktop'; install = 'winget install --id Microsoft.PowerBI -e' }) }

if ($Catalog) {
    $py = $null
    foreach ($cand in @(@('py', '-3.12'), @('python'), @('py', '-3'))) {
        if (-not (Get-Command $cand[0] -ErrorAction SilentlyContinue)) { continue }
        $pre = @($cand | Select-Object -Skip 1)
        # no Select-Object -First here: it stops the process early and sets $LASTEXITCODE to -1
        $ver = @(& $cand[0] @pre -c 'import sys, openpyxl; print(sys.version.split()[0])' 2>$null)
        $ver = $(if ($ver.Count) { $ver[0] } else { $null })
        if ($ver -match '^3\.\d+') { $py = [ordered]@{ command = ($cand -join ' '); version = ([string]$ver).Trim(); openpyxl = $true }; break }
    }
    $out.python = $py
    if (-not $py) { $missing.Add([ordered]@{ program = 'Python 3.12 + openpyxl (data catalog)'; install = 'winget install --id Python.Python.3.12 -e --scope user, then py -3.12 -m pip install openpyxl' }) }
}

$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
$out.freeMemoryGB = $(if ($os) { [Math]::Round($os.FreePhysicalMemory / 1MB, 1) } else { $null })
$out['missing'] = $missing.ToArray()
$out | ConvertTo-Json -Depth 4

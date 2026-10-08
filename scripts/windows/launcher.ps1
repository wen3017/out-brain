param(
    [ValidateSet('menu', 'start', 'stop', 'setup', 'configure')]
    [string]$Action = 'menu'
)

$interactive = $Action -eq 'menu'
if ($interactive) {
    Write-Host ''
    Write-Host 'NBBOSS - Local workspace'
    Write-Host '1. Start application'
    Write-Host '2. Stop application (keep data)'
    Write-Host '3. First-time setup'
    Write-Host '4. Configure email / search services'
    Write-Host '0. Exit'
    $selection = Read-Host 'Select an action'
    $actions = @{ '1' = 'start'; '2' = 'stop'; '3' = 'setup'; '4' = 'configure' }
    if ($selection -eq '0') { exit 0 }
    if (!$actions.ContainsKey($selection)) { Write-Host 'Invalid selection.'; exit 1 }
    $Action = $actions[$selection]
}

$scripts = @{
    start = 'start.ps1'
    stop = 'stop.ps1'
    setup = 'setup.ps1'
    configure = 'configure-services-gui.ps1'
}
$arguments = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass')
if ($Action -eq 'configure') {
    # The GUI needs Windows PowerShell's own module paths and an STA thread.
    $env:PSModulePath = ''
    $arguments += '-STA'
}
$arguments += @('-File', (Join-Path $PSScriptRoot $scripts[$Action]))
& powershell.exe @arguments
$result = $LASTEXITCODE
if ($interactive) { [void](Read-Host 'Press Enter to close') }
exit $result

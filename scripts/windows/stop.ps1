param([switch]$ApplicationOnly)
. (Join-Path $PSScriptRoot 'common.ps1')
$launcherLock = $null
$exitCode = 0
try {
    $launcherLock = Enter-LauncherLock
    $services = if ($ApplicationOnly) { @('web', 'worker', 'api') } else { @('web', 'worker', 'api', 'redis', 'postgres') }
    foreach ($name in $services) {
        try { Stop-ManagedService $name } catch {
            $exitCode = 1
            Write-Warning "Could not stop ${name}: $($_.Exception.Message)"
        }
    }
    if ($exitCode -eq 0) { Write-Host 'Selected project services are stopped. Database, uploads and Redis data have been preserved.' }
} catch {
    $exitCode = 1
    Write-Host $_.Exception.Message -ForegroundColor Red
} finally {
    if ($launcherLock) { $launcherLock.Dispose() }
}
exit $exitCode

param([switch]$NoOpen)
. (Join-Path $PSScriptRoot 'common.ps1')
$launcherLock = $null
$newServices = New-Object 'System.Collections.Generic.List[string]'
$previousEnvironment = @{}
$externalLlm = $null
$exitCode = 0
try {
    $launcherLock = Enter-LauncherLock
    $values = Read-ProjectEnv
    $externalLlm = Read-ExternalLlmConfig
    $pgPort = Get-LocalServicePort $values 'DATABASE_URL' 5432
    $redisPort = Get-LocalServicePort $values 'REDIS_URL' 6379
    $apiPort = 3001
    if ($values.ContainsKey('API_PORT')) { $apiPort = [int]$values.API_PORT }
    $webPort = 3000
    if ($values.ContainsKey('APP_URL') -and $values.APP_URL) {
        $appUri = [Uri]$values.APP_URL
        if ($appUri.Host -notin @('localhost', '127.0.0.1', '[::1]', '::1')) { throw 'APP_URL must point to localhost for local Windows development.' }
        $webPort = $appUri.Port
    }
    foreach ($port in @($pgPort, $redisPort, $apiPort, $webPort)) {
        if ($port -lt 1 -or $port -gt 65535) { throw 'Invalid port in .env.' }
    }
    if (@(@($pgPort, $redisPort, $apiPort, $webPort) | Select-Object -Unique).Count -ne 4) { throw 'PostgreSQL, Redis, API and Web must use different ports.' }
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $pnpm = (Get-Command pnpm.cmd -ErrorAction Stop).Source
    $pgCtl = Join-Path $script:LocalRoot 'postgres\pgsql\bin\pg_ctl.exe'
    $pgData = Join-Path $script:LocalRoot 'data\postgres'
    $redisExe = Join-Path $script:LocalRoot 'redis\redis-server.exe'
    $vite = Join-Path $script:ProjectRoot 'apps\web\node_modules\vite\bin\vite.js'
    foreach ($required in @($pgCtl, (Join-Path $pgData 'PG_VERSION'), $redisExe, (Join-Path $script:LocalRoot 'redis.conf'), $vite)) {
        if (!(Test-Path -LiteralPath $required)) { throw 'The local environment is incomplete. Run start.cmd setup first.' }
    }
    Assert-ServicePort 'postgres' $pgPort
    Assert-ServicePort 'redis' $redisPort
    Assert-ServicePort 'api' $apiPort
    Assert-ServicePort 'web' $webPort

    foreach ($key in $values.Keys) {
        $previousEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, [string]$values[$key], 'Process')
    }
    if (!$previousEnvironment.ContainsKey('WORKER_MODE')) { $previousEnvironment['WORKER_MODE'] = [Environment]::GetEnvironmentVariable('WORKER_MODE', 'Process') }

    if (!(Get-ManagedRecord 'postgres')) {
        Write-Host 'Starting PostgreSQL...'
        # Do not redirect pg_ctl through a PowerShell pipeline: the daemon can
        # inherit that pipe and keep Windows PowerShell waiting indefinitely.
        & $pgCtl -D $pgData -l (Join-Path $script:LogRoot 'postgres.log') -o "-h 127.0.0.1 -p $pgPort" -w -t 60 start
        $code = $LASTEXITCODE
        if ($code -ne 0) { throw 'PostgreSQL failed to start. Check .local\logs\postgres.log.' }
        $pgProcessId = [int](Get-Content -LiteralPath (Join-Path $pgData 'postmaster.pid') -TotalCount 1)
        Save-ManagedRecord 'postgres' $pgProcessId $pgPort
        $newServices.Add('postgres')
    }
    Wait-ServicePort 'postgres' $pgPort

    if (!(Get-ManagedRecord 'redis')) {
        Write-Host 'Starting Redis...'
        $process = Start-Process -FilePath $redisExe -ArgumentList @('redis.conf', '--port', "$redisPort") -WorkingDirectory $script:LocalRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $script:LogRoot 'redis.stdout.log') -RedirectStandardError (Join-Path $script:LogRoot 'redis.stderr.log') -PassThru
        Save-ManagedRecord 'redis' $process.Id $redisPort
        $newServices.Add('redis')
    }
    Wait-ServicePort 'redis' $redisPort

    Push-Location $script:ProjectRoot
    try {
        if (!(Get-ManagedRecord 'api') -or !(Get-ManagedRecord 'worker')) {
            Write-Host 'Building shared contracts and API...'
            $code = Invoke-LoggedNative $pnpm @('--filter', '@nbboss/contracts', 'build') (Join-Path $script:LogRoot 'build-contracts.log')
            if ($code -ne 0) { throw 'Contracts build failed. Check .local\logs\build-contracts.log.' }
            $code = Invoke-LoggedNative $pnpm @('--filter', '@nbboss/api', 'build') (Join-Path $script:LogRoot 'build-api.log')
            if ($code -ne 0) { throw 'API build failed. Check .local\logs\build-api.log.' }
        }
        Write-Host 'Applying database migrations...'
        $code = Invoke-LoggedNative $pnpm @('--filter', '@nbboss/api', 'exec', 'prisma', 'migrate', 'deploy') (Join-Path $script:LogRoot 'migrate.log')
        if ($code -ne 0) { throw 'Database migration failed. Check .local\logs\migrate.log.' }
    } finally { Pop-Location }

    $apiDirectory = Join-Path $script:ProjectRoot 'apps\api'
    $providerEnvironment = @{}
    $serviceEnvironment = Read-ExternalServicesConfig
    $serviceEnvironment.OCR_CACHE_PATH = Join-Path $script:ProjectRoot 'data\ocr-cache'
    try {
    foreach ($key in $serviceEnvironment.Keys) {
        $providerEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, [string]$serviceEnvironment[$key], 'Process')
    }
    if ($externalLlm) {
        foreach ($key in $externalLlm.Keys) {
            $providerEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
            [Environment]::SetEnvironmentVariable($key, [string]$externalLlm[$key], 'Process')
        }
    }
    foreach ($name in @('api', 'worker')) {
        if (!(Get-ManagedRecord $name)) {
            Archive-ServiceLogs $name
            Write-Host "Starting $name (model: $env:LLM_MODEL)..."
            $env:WORKER_MODE = if ($name -eq 'worker') { 'true' } else { 'false' }
            $process = Start-Process -FilePath $node -ArgumentList @('dist/main.js') -WorkingDirectory $apiDirectory -WindowStyle Hidden -RedirectStandardOutput (Join-Path $script:LogRoot "$name.stdout.log") -RedirectStandardError (Join-Path $script:LogRoot "$name.stderr.log") -PassThru
            $port = if ($name -eq 'api') { $apiPort } else { 0 }
            Save-ManagedRecord $name $process.Id $port
            $newServices.Add($name)
        }
    }
    } finally {
        foreach ($key in $providerEnvironment.Keys) {
            [Environment]::SetEnvironmentVariable($key, $providerEnvironment[$key], 'Process')
        }
    }
    if (!(Get-ManagedRecord 'web')) {
        Archive-ServiceLogs 'web'
        Write-Host 'Starting Web...'
        $env:WORKER_MODE = 'false'
        $process = Start-Process -FilePath $node -ArgumentList @('node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', "$webPort", '--strictPort') -WorkingDirectory (Join-Path $script:ProjectRoot 'apps\web') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $script:LogRoot 'web.stdout.log') -RedirectStandardError (Join-Path $script:LogRoot 'web.stderr.log') -PassThru
        Save-ManagedRecord 'web' $process.Id $webPort
        $newServices.Add('web')
    }
    Write-Host 'Waiting for application readiness...'
    Wait-ServicePort 'api' $apiPort
    Wait-ServicePort 'web' $webPort
    Wait-ServiceHttp 'api' "http://127.0.0.1:$apiPort/api/health/system"
    Wait-ServiceHttp 'web' "http://127.0.0.1:$webPort/"
    Start-Sleep -Seconds 2
    if (!(Get-ManagedRecord 'worker')) { throw 'Worker exited during startup. Check .local\logs\worker.stderr.log.' }
    Write-Host ''
    Write-Host "Ready: http://localhost:$webPort"
    Write-Host "API health: http://localhost:$apiPort/api/health/system"
    Write-Host "Logs: $script:LogRoot"
    Write-Host 'To stop all project services and retain data, run start.cmd stop.'
    # Existing processes retain their startup configuration. Report the running
    # API's capability instead of inferring it from the current .env file.
    try {
        $capabilities = Invoke-RestMethod -Uri "http://127.0.0.1:$apiPort/api/health/capabilities" -TimeoutSec 5
        if ($capabilities.model) {
            Write-Host 'AI model configuration: enabled in the running API (provider connectivity is not tested here).'
            if ($newServices.Contains('api') -and $externalLlm) {
                Write-Host ('Model: ' + $externalLlm.LLM_MODEL + ' (encrypted configuration outside the project).')
            }
        } else {
            Write-Host 'AI model configuration: disabled in the running API. Configure the model and set LLM_ENABLED=true, then stop and start the application.'
        }
        if (!$newServices.Contains('api')) {
            Write-Host 'Existing API process reused. Configuration changes require a stop/start.'
        }
    } catch {
        Write-Host 'Could not read the running AI configuration. Check /api/health/capabilities.'
    }
    if (!$NoOpen) { Start-Process "http://localhost:$webPort" }
} catch {
    $exitCode = 1
    Write-Host "Startup failed: $($_.Exception.Message)" -ForegroundColor Red
    for ($index = $newServices.Count - 1; $index -ge 0; $index--) {
        try { Stop-ManagedService $newServices[$index] } catch { Write-Warning $_.Exception.Message }
    }
} finally {
    if ($externalLlm) { $externalLlm.Clear() }
    foreach ($key in $previousEnvironment.Keys) { [Environment]::SetEnvironmentVariable($key, $previousEnvironment[$key], 'Process') }
    if ($launcherLock) { $launcherLock.Dispose() }
}
exit $exitCode

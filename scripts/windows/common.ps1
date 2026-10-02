Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$script:LocalRoot = Join-Path $script:ProjectRoot '.local'
$script:LogRoot = Join-Path $script:LocalRoot 'logs'
$script:RunRoot = Join-Path $script:LocalRoot 'run'
foreach ($directory in @($script:LogRoot, $script:RunRoot)) {
    [void][IO.Directory]::CreateDirectory($directory)
}

function Enter-LauncherLock {
    try {
        return [IO.File]::Open((Join-Path $script:RunRoot 'launcher.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch {
        throw 'Another start/stop command is running. Wait for it to finish and try again.'
    }
}

function Invoke-LoggedNative([string]$Executable, [string[]]$Arguments, [string]$LogPath) {
    $previousPreference = $ErrorActionPreference
    try {
        # Windows PowerShell treats redirected native stderr as ErrorRecords.
        # A warning on stderr must not turn an otherwise successful command into a failure.
        $ErrorActionPreference = 'Continue'
        & $Executable @Arguments *> $LogPath
        return $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
}

function Read-ProjectEnv {
    $path = Join-Path $script:ProjectRoot '.env'
    if (!(Test-Path -LiteralPath $path)) { throw 'Missing .env. Run setup.cmd first.' }
    $values = @{}
    $lineNumber = 0
    foreach ($line in [IO.File]::ReadAllLines($path)) {
        $lineNumber++
        $trimmed = $line.Trim()
        if (!$trimmed -or $trimmed.StartsWith('#')) { continue }
        if ($trimmed -notmatch '^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            throw "Invalid .env syntax on line $lineNumber."
        }
        $name = $Matches[1]
        $value = $Matches[2]
        if ($value.StartsWith('"') -or $value.StartsWith("'")) {
            $quote = $value.Substring(0, 1)
            $lastQuote = $value.LastIndexOf($quote)
            if ($lastQuote -lt 1) { throw "Unclosed .env quote on line $lineNumber." }
            $tail = $value.Substring($lastQuote + 1).Trim()
            if ($tail -and !$tail.StartsWith('#')) { throw "Invalid .env syntax on line $lineNumber." }
            $value = $value.Substring(1, $lastQuote - 1)
            if ($quote -eq '"') { $value = $value.Replace('\n', "`n").Replace('\r', "`r") }
        } else {
            $value = ($value -replace '\s*#.*$', '').Trim()
        }
        $values[$name] = $value
    }
    return $values
}

function Read-ExternalServicesConfig {
    $path = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'NBBOSS\services.json'
    $values = @{}
    if (!(Test-Path -LiteralPath $path)) { return $values }
    try {
        $config = [IO.File]::ReadAllText($path) | ConvertFrom-Json
        $allowed = @('SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_FROM','SMTP_TO','SMTP_ENABLED','SMTP_PROVIDER','SEARCH_ENABLED','SEARCH_PROVIDER')
        foreach ($property in $config.PSObject.Properties) {
            if ($property.Name -in $allowed) { $values[$property.Name] = [string]$property.Value }
            elseif ($property.Name -in @('SMTP_PASSWORD_DPAPI','SEARCH_API_KEY_DPAPI')) {
                $secure = ConvertTo-SecureString ([string]$property.Value)
                $credential = New-Object Management.Automation.PSCredential('service', $secure)
                $values[$property.Name.Replace('_DPAPI','')] = $credential.GetNetworkCredential().Password
            }
        }
        return $values
    } catch { throw 'Cannot decrypt external services.json with this Windows account.' }
}

function Read-ExternalLlmConfig {
    # Keep provider credentials outside the checkout. DPAPI binds the encrypted
    # value to the current Windows user; only the API and Worker receive it.
    $directory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'NBBOSS'
    $path = Join-Path $directory 'provider.json'
    if (!(Test-Path -LiteralPath $path)) { return $null }
    try {
        $config = [IO.File]::ReadAllText($path) | ConvertFrom-Json
        $baseUri = $null
        if (![Uri]::TryCreate([string]$config.baseUrl, [UriKind]::Absolute, [ref]$baseUri) -or
            $baseUri.Scheme -ne 'https' -or $baseUri.UserInfo -or !$config.model) {
            throw 'Invalid provider configuration.'
        }
        $secureKey = ConvertTo-SecureString ([string]$config.apiKeyDpapi)
        $credential = New-Object System.Management.Automation.PSCredential('provider', $secureKey)
        $apiKey = $credential.GetNetworkCredential().Password
        if (!$apiKey) { throw 'Empty provider key.' }
        return @{
            LLM_BASE_URL = [string]$config.baseUrl
            LLM_MODEL = [string]$config.model
            LLM_API_KEY = $apiKey
        }
    } catch {
        # Never include JSON contents or decryption exceptions in logs.
        throw 'Cannot read the external LLM configuration in %LOCALAPPDATA%\NBBOSS\provider.json. Use the Windows account that saved it.'
    }
}

function Get-LocalServicePort([hashtable]$Values, [string]$Key, [int]$DefaultPort) {
    if (!$Values.ContainsKey($Key) -or !$Values[$Key]) { throw "Missing $Key in .env. Run setup.cmd first." }
    $parsed = $null
    if (![Uri]::TryCreate($Values[$Key], [UriKind]::Absolute, [ref]$parsed)) { throw "Invalid $Key in .env." }
    if ($parsed.Host -notin @('localhost', '127.0.0.1', '[::1]', '::1')) {
        throw "$Key must point to localhost for these portable Windows launchers."
    }
    if ($parsed.Port -gt 0) { return $parsed.Port }
    return $DefaultPort
}

function Get-RecordPath([string]$Name) { return Join-Path $script:RunRoot "$Name.json" }

function Get-ManagedRecord([string]$Name) {
    $path = Get-RecordPath $Name
    if (!(Test-Path -LiteralPath $path)) { return $null }
    try {
        $record = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
        $process = Get-Process -Id ([int]$record.pid) -ErrorAction Stop
        if ($process.StartTime.ToUniversalTime().Ticks.ToString() -ne [string]$record.startTimeUtcTicks) { return $null }
        if (![string]::Equals($process.Path, [string]$record.executable, [StringComparison]::OrdinalIgnoreCase)) { return $null }
        return $record
    } catch { return $null }
}

function Save-ManagedRecord([string]$Name, [int]$ProcessId, [int]$Port = 0) {
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    $record = [ordered]@{
        pid = $process.Id
        startTimeUtcTicks = $process.StartTime.ToUniversalTime().Ticks.ToString()
        executable = $process.Path
        port = $Port
    }
    $record | ConvertTo-Json | Set-Content -LiteralPath (Get-RecordPath $Name) -Encoding UTF8
}

function Get-PortOwners([int]$Port) {
    # Query all listeners so a missing local port is not treated as a cmdlet error.
    return @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $Port } | Select-Object -ExpandProperty OwningProcess -Unique)
}

function Test-OwnedProcess([int]$ProcessId, [int]$OwnerId) {
    # PostgreSQL and Vite may delegate to a child process. Never accept unrelated PIDs.
    for ($depth = 0; $depth -lt 16 -and $ProcessId -gt 0; $depth++) {
        if ($ProcessId -eq $OwnerId) { return $true }
        $child = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
        if (!$child) { return $false }
        $ProcessId = [int]$child.ParentProcessId
    }
    return $false
}

function Assert-ServicePort([string]$Name, [int]$Port) {
    $record = Get-ManagedRecord $Name
    if ($record -and [int]$record.port -ne $Port) { throw "$Name is already running with a different port. Run stop.cmd before changing .env." }
    foreach ($ownerId in @(Get-PortOwners $Port)) {
        if (!$record -or !(Test-OwnedProcess ([int]$ownerId) ([int]$record.pid))) {
            throw "Port $Port is occupied by another process (PID $ownerId). Stop that program or change the project port; the launcher will not take it over."
        }
    }
}

function Wait-ServicePort([string]$Name, [int]$Port, [int]$TimeoutSeconds = 30) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $record = Get-ManagedRecord $Name
        if (!$record) { throw "$Name exited during startup. Check $script:LogRoot." }
        $owners = @(Get-PortOwners $Port)
        foreach ($ownerId in $owners) {
            if (!(Test-OwnedProcess ([int]$ownerId) ([int]$record.pid))) { throw "Port $Port was taken by another process during startup." }
        }
        if ($owners.Count -gt 0) { return }
        Start-Sleep -Milliseconds 400
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "$Name did not start listening on port $Port. Check $script:LogRoot."
}

function Wait-ServiceHttp([string]$Name, [string]$Url, [int]$TimeoutSeconds = 90) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (!(Get-ManagedRecord $Name)) { throw "$Name exited during startup. Check $script:LogRoot." }
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
            if ($response.StatusCode -eq 200) { return }
        } catch { }
        Start-Sleep -Milliseconds 600
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "$Name did not become ready at $Url. Check $script:LogRoot."
}

function Stop-ManagedService([string]$Name) {
    $record = Get-ManagedRecord $Name
    if (!$record) {
        if (Test-Path -LiteralPath (Get-RecordPath $Name)) {
            Write-Host "$Name is stopped or its old PID was reused; no process was terminated."
            Remove-Item -LiteralPath (Get-RecordPath $Name) -Force
        }
        return
    }
    if ($Name -eq 'postgres') {
        $pgCtl = Join-Path $script:LocalRoot 'postgres\pgsql\bin\pg_ctl.exe'
        $data = Join-Path $script:LocalRoot 'data\postgres'
        $postmaster = Join-Path $data 'postmaster.pid'
        if (!(Test-Path -LiteralPath $postmaster) -or [int](Get-Content -LiteralPath $postmaster -TotalCount 1) -ne [int]$record.pid) {
            throw 'PostgreSQL identity does not match the launcher record. Refusing to stop it.'
        }
        & $pgCtl -D $data -m fast -w -t 60 stop
        $code = $LASTEXITCODE
        if ($code -ne 0) { throw 'PostgreSQL could not stop. Check .local\logs\postgres.log.' }
    } elseif ($Name -eq 'redis') {
        Assert-ServicePort 'redis' ([int]$record.port)
        $cli = Join-Path $script:LocalRoot 'redis\redis-cli.exe'
        if (Test-Path -LiteralPath $cli) {
            $null = Invoke-LoggedNative $cli @('-h', '127.0.0.1', '-p', [string]$record.port, 'shutdown') (Join-Path $script:LogRoot 'redis-stop.log')
            for ($attempt = 0; $attempt -lt 20 -and (Get-ManagedRecord $Name); $attempt++) { Start-Sleep -Milliseconds 250 }
        }
        if (Get-ManagedRecord $Name) { Stop-Process -Id ([int]$record.pid) -Force -ErrorAction Stop }
    } else {
        Stop-Process -Id ([int]$record.pid) -Force -ErrorAction Stop
    }
    Remove-Item -LiteralPath (Get-RecordPath $Name) -Force -ErrorAction SilentlyContinue
    Write-Host "Stopped $Name."
}

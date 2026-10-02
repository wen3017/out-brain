[CmdletBinding()]
param([switch]$SkipDependencies)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$localRoot = Join-Path $projectRoot '.local'
Set-Location $projectRoot
. (Join-Path $PSScriptRoot 'common.ps1')
$setupLock = Enter-LauncherLock
try {
foreach ($service in @('postgres', 'redis', 'api', 'worker', 'web')) {
    if (Get-ManagedRecord $service) {
        throw 'Project services are running. Run stop.cmd before reconfiguring the environment.'
    }
}

function Write-Utf8File([string]$Path, [string]$Text) {
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}

function New-Secret {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}

function Get-Archive([string]$Url, [string]$Name, [string]$Sha256, [switch]$GitHubAsset) {
    $destination = Join-Path $localRoot "downloads/$Name"
    if ((Test-Path -LiteralPath $destination) -and
        (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -eq $Sha256) {
        return $destination
    }
    Write-Host "Downloading $Name ..."
    $partial = "$destination.partial"
    $curlArgs = @('-L', '--fail', '--retry', '3', '--connect-timeout', '30', '--max-time', '900', '--silent', '--show-error')
    if ($GitHubAsset) {
        $curlArgs += @('-H', 'Accept: application/octet-stream', '-H', 'X-GitHub-Api-Version: 2022-11-28', '-H', 'User-Agent: NBBOSS-local-setup')
    }
    & curl.exe @curlArgs --output $partial $Url
    if ($LASTEXITCODE -ne 0) { throw "Download failed: $Name. Run setup.cmd again to retry." }
    if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ne $Sha256) {
        throw "SHA256 verification failed: $Name"
    }
    Move-Item -LiteralPath $partial -Destination $destination -Force
    return $destination
}

foreach ($command in @('node', 'pnpm.cmd', 'curl.exe', 'tar.exe')) {
    if (!(Get-Command $command -ErrorAction SilentlyContinue)) { throw "Missing command: $command" }
}
& node -e 'const [a,b]=process.versions.node.split(/\./).map(Number); process.exit(a>22||(a===22&&b>=19)?0:1)'
if ($LASTEXITCODE -ne 0) { throw 'Node.js >=22.19 is required; Node.js 24 is recommended.' }
foreach ($directory in @('downloads', 'postgres', 'redis', 'src', 'logs', 'data/redis', 'run')) {
    New-Item -ItemType Directory -Force (Join-Path $localRoot $directory) | Out-Null
}

$pgRoot = Join-Path $localRoot 'postgres/pgsql'
$pgBin = Join-Path $pgRoot 'bin'
if (!(Test-Path (Join-Path $pgBin 'postgres.exe'))) {
    $archive = Get-Archive 'https://get.enterprisedb.com/postgresql/postgresql-16.15-4-windows-x64-binaries.zip' `
        'postgresql-16.15-4-windows-x64-binaries.zip' 'f5f55b03bd54ce0dd1c51d524b54c7e015abd4d620af27d6971288a2dbe4a8f8'
    & tar.exe -xf $archive -C (Join-Path $localRoot 'postgres') pgsql/bin pgsql/lib pgsql/share pgsql/include
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL extraction failed.' }
}

if (!(Test-Path (Join-Path $pgRoot 'lib/vector.dll'))) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    if (!(Test-Path $vswhere)) { throw 'Visual Studio C++ build tools are needed to compile pgvector.' }
    $vsRoot = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (!$vsRoot) { throw 'Install the Visual Studio Desktop development with C++ workload, then rerun setup.cmd.' }
    $archive = Get-Archive 'https://codeload.github.com/pgvector/pgvector/zip/refs/tags/v0.8.6' `
        'pgvector-v0.8.6.zip' 'e93a1567219c9ce523ca16473f6c41cc80e01345b2d91ccdee40b473b7c5dd0a'
    Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $localRoot 'src') -Force
    $source = Join-Path $localRoot 'src/pgvector-0.8.6'
    $vsDev = Join-Path $vsRoot 'Common7/Tools/VsDevCmd.bat'
    $buildFile = Join-Path $localRoot 'run/build-pgvector.cmd'
    $buildText = @"
@echo off
call "$vsDev" -arch=x64 -host_arch=x64 >nul
if errorlevel 1 exit /b 1
set "PGROOT=$pgRoot"
cd /d "$source"
nmake /NOLOGO /F Makefile.win
if errorlevel 1 exit /b 1
nmake /NOLOGO /F Makefile.win install
"@
    [IO.File]::WriteAllText($buildFile, $buildText, [Text.Encoding]::Default)
    Write-Host 'Building pgvector with the installed Visual Studio C++ tools ...'
    & $buildFile *> (Join-Path $localRoot 'logs/pgvector-build.log')
    if ($LASTEXITCODE -ne 0) { throw 'pgvector build failed. See .local/logs/pgvector-build.log.' }
}

if (!(Test-Path (Join-Path $localRoot 'redis/redis-server.exe'))) {
    $archive = Get-Archive 'https://api.github.com/repos/redis-windows/redis-windows/releases/assets/519261973' `
        'Redis-7.2.16-Windows-x64-cygwin.zip' 'ccbb1d2fdbdc339c26cb369723b54c2fe23291136e8d9ca293345960742e864c' -GitHubAsset
    Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $localRoot 'redis') -Force
    $source = (Resolve-Path (Join-Path $localRoot 'redis/Redis-7.2.16-Windows-x64-cygwin')).Path
    $destination = (Resolve-Path (Join-Path $localRoot 'redis')).Path
    $allowedRoot = $localRoot + [IO.Path]::DirectorySeparatorChar
    if (!$source.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase) -or
        !$destination.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Unexpected Redis extraction path.'
    }
    Get-ChildItem -LiteralPath $source -Force | ForEach-Object {
        Move-Item -LiteralPath $_.FullName -Destination $destination
    }
    Remove-Item -LiteralPath $source
}

$envPath = Join-Path $projectRoot '.env'
if (!(Test-Path -LiteralPath $envPath)) {
    $configuration = Get-Content -LiteralPath (Join-Path $projectRoot '.env.example') -Raw -Encoding UTF8
    $password = New-Secret
    $configuration = $configuration -replace '(?m)^DATABASE_URL=.*$', "DATABASE_URL=postgresql://nbboss:${password}@127.0.0.1:5432/nbboss?schema=public"
    $configuration = $configuration -replace '(?m)^REDIS_URL=.*$', 'REDIS_URL=redis://127.0.0.1:6379'
    $storagePath = (Join-Path $projectRoot 'data/uploads').Replace('\', '/')
    $configuration = $configuration -replace '(?m)^STORAGE_ROOT=.*$', "STORAGE_ROOT=$storagePath"
    $configuration = $configuration -replace '(?m)^JWT_ACCESS_SECRET=.*$', ('JWT_ACCESS_SECRET=' + (New-Secret))
    $configuration = $configuration -replace '(?m)^JWT_REFRESH_SECRET=.*$', ('JWT_REFRESH_SECRET=' + (New-Secret))
    Write-Utf8File $envPath $configuration
    Write-Host 'Created .env with random database and JWT secrets. LLM_API_KEY remains for you to fill in.'
} else {
    Write-Host 'Preserving existing .env.'
}

$settings = Read-ProjectEnv
$database = $null
$redis = $null
if (![Uri]::TryCreate($settings.DATABASE_URL, [UriKind]::Absolute, [ref]$database)) {
    throw 'Invalid DATABASE_URL in .env.'
}
if (![Uri]::TryCreate($settings.REDIS_URL, [UriKind]::Absolute, [ref]$redis)) {
    throw 'Invalid REDIS_URL in .env.'
}
if ($database.Host -notin @('localhost', '127.0.0.1') -or $redis.Host -notin @('localhost', '127.0.0.1')) {
    throw 'This portable setup needs localhost/127.0.0.1 DATABASE_URL and REDIS_URL. Update .env first; existing values have been preserved.'
}
$pgPort = if ($database.Port -gt 0) { $database.Port } else { 5432 }
$redisPort = if ($redis.Port -gt 0) { $redis.Port } else { 6379 }
if ($redis.UserInfo) { throw 'This local Redis setup expects REDIS_URL without credentials.' }
$login = $database.UserInfo -split ':', 2
$pgUser = [Uri]::UnescapeDataString($login[0])
$pgPassword = if ($login.Length -eq 2) { [Uri]::UnescapeDataString($login[1]) } else { '' }
$pgDatabase = $database.AbsolutePath.TrimStart('/')
if (!$pgPassword -or $pgUser -notmatch '^[a-zA-Z_][a-zA-Z0-9_]*$' -or $pgDatabase -notmatch '^[a-zA-Z_][a-zA-Z0-9_]*$') {
    throw 'DATABASE_URL must have a password and simple alphanumeric database/user names.'
}
Write-Utf8File (Join-Path $localRoot 'redis.conf') @"
bind 127.0.0.1
protected-mode yes
port $redisPort
daemonize no
dir ./data/redis
appendonly yes
appendfsync everysec
save 60 1
loglevel notice
"@

$pgData = Join-Path $localRoot 'data/postgres'
$setupMarker = Join-Path $localRoot 'setup.json'
if (!(Test-Path (Join-Path $pgData 'PG_VERSION'))) {
    $passwordFile = Join-Path $localRoot 'run/init-password.txt'
    try {
        Write-Utf8File $passwordFile $pgPassword
        & (Join-Path $pgBin 'initdb.exe') -D $pgData -U $pgUser --auth=scram-sha-256 --encoding=UTF8 --locale=C --pwfile=$passwordFile
        if ($LASTEXITCODE -ne 0) { throw 'Database initialization failed.' }
    } finally {
        if (Test-Path -LiteralPath $passwordFile) { Remove-Item -LiteralPath $passwordFile }
    }
}
if (!(Test-Path -LiteralPath $setupMarker)) {
    if (Get-NetTCPConnection -State Listen -LocalPort $pgPort -ErrorAction SilentlyContinue) {
        throw "Port $pgPort is in use. Stop the conflicting database before running setup.cmd again."
    }
    $started = $false
    $oldPassword = $env:PGPASSWORD
    try {
        & (Join-Path $pgBin 'pg_ctl.exe') -D $pgData -l (Join-Path $localRoot 'logs/postgres.log') -o "-h 127.0.0.1 -p $pgPort" -w start
        if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL startup failed. See .local/logs/postgres.log.' }
        $started = $true
        $env:PGPASSWORD = $pgPassword
        $exists = & (Join-Path $pgBin 'psql.exe') -h 127.0.0.1 -p $pgPort -U $pgUser -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$pgDatabase'"
        if ($LASTEXITCODE -ne 0) { throw 'Cannot connect to the local PostgreSQL database.' }
        if (($exists | Out-String).Trim() -ne '1') {
            & (Join-Path $pgBin 'createdb.exe') -h 127.0.0.1 -p $pgPort -U $pgUser $pgDatabase
            if ($LASTEXITCODE -ne 0) { throw 'Database creation failed.' }
        }
        & (Join-Path $pgBin 'psql.exe') -h 127.0.0.1 -p $pgPort -U $pgUser -d $pgDatabase -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION IF NOT EXISTS vector;'
        if ($LASTEXITCODE -ne 0) { throw 'pgvector extension initialization failed.' }
        Write-Utf8File $setupMarker (@{ postgres = '16.15'; pgvector = '0.8.6'; redis = '7.2.16'; initializedAt = (Get-Date).ToString('o') } | ConvertTo-Json)
    } finally {
        $env:PGPASSWORD = $oldPassword
        if ($started) { & (Join-Path $pgBin 'pg_ctl.exe') -D $pgData -m fast -w stop }
    }
}

if (!$SkipDependencies) {
    & pnpm.cmd install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}
$oldDatabaseUrl = $env:DATABASE_URL
try {
    $env:DATABASE_URL = $settings.DATABASE_URL
    & pnpm.cmd db:generate
    if ($LASTEXITCODE -ne 0) { throw 'Prisma client generation failed.' }
    & pnpm.cmd --filter '@nbboss/contracts' build
    if ($LASTEXITCODE -ne 0) { throw 'Shared contracts build failed.' }
} finally { $env:DATABASE_URL = $oldDatabaseUrl }
Write-Host ''
Write-Host 'Setup complete. Fill LLM_API_KEY in .env, then run start.cmd.'
Write-Host 'PostgreSQL, Redis, data and logs are kept inside .local. No Docker is required.'
} finally {
    $setupLock.Dispose()
}

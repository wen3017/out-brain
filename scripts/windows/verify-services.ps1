. (Join-Path $PSScriptRoot 'common.ps1')
$settings = Read-ExternalServicesConfig
$original = @{}
try {
    foreach ($key in $settings.Keys) {
        $original[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, [string]$settings[$key], 'Process')
    }
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    & $node (Join-Path $script:ProjectRoot 'scripts\acceptance\verify-external-services.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Service verification could not complete.' }
} finally {
    foreach ($key in $original.Keys) { [Environment]::SetEnvironmentVariable($key, $original[$key], 'Process') }
    $settings.Clear()
}

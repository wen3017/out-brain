param([ValidateSet('smtp','search')][string]$Service = 'smtp')
$ErrorActionPreference = 'Stop'
$directory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'NBBOSS'
[void][IO.Directory]::CreateDirectory($directory)
$path = Join-Path $directory 'services.json'
$values = @{}
if (Test-Path -LiteralPath $path) {
    $existing = [IO.File]::ReadAllText($path) | ConvertFrom-Json
    foreach ($property in $existing.PSObject.Properties) { $values[$property.Name] = $property.Value }
}
if ($Service -eq 'smtp') {
    $email = Read-Host '163 sender email address'
    if ($email -notmatch '^[^\s@]+@163\.com$') { throw 'Enter a valid 163.com sender address.' }
    $recipient = Read-Host 'Recipient email address (enter the sender address to test delivery to yourself)'
    if ($recipient -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') { throw 'Enter a valid recipient address.' }
    $secret = Read-Host '163 SMTP authorization code (not your login password)' -AsSecureString
    if ($secret.Length -eq 0) { throw 'Authorization code is required.' }
    $values.SMTP_HOST = 'smtp.163.com'
    $values.SMTP_PORT = '465'
    $values.SMTP_USER = $email
    $values.SMTP_FROM = $email
    $values.SMTP_TO = $recipient
    $values.SMTP_PASSWORD_DPAPI = ConvertFrom-SecureString $secret
    $values.SMTP_ENABLED = 'true'
    $values.SMTP_PROVIDER = 'smtp'
} else {
    $secret = Read-Host 'Tavily API key' -AsSecureString
    if ($secret.Length -eq 0) { throw 'API key is required.' }
    $values.SEARCH_API_KEY_DPAPI = ConvertFrom-SecureString $secret
    $values.SEARCH_ENABLED = 'true'
    $values.SEARCH_PROVIDER = 'tavily'
}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $directory '/inheritance:r' '/grant:r' ('*' + $sid + ':(OI)(CI)F') *> $null
if ($LASTEXITCODE -ne 0) { throw 'Cannot restrict the local configuration directory.' }
[IO.File]::WriteAllText($path, ($values | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
Write-Host 'Saved encrypted credentials outside the project. Run start.cmd stop then start.cmd to apply.'
Write-Host 'No email was sent by this configuration command.'

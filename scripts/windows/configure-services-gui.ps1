param([string]$SenderEmail = '', [string]$RecipientEmail = '', [switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$directory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'NBBOSS'
$configPath = Join-Path $directory 'services.json'

function Save-Settings([hashtable]$Changes) {
    [void][IO.Directory]::CreateDirectory($directory)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $directory '/inheritance:r' '/grant:r' ('*' + $sid + ':(OI)(CI)F') *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot restrict the local configuration directory.' }
    $values = @{}
    if (Test-Path -LiteralPath $configPath) {
        foreach ($property in ([IO.File]::ReadAllText($configPath) | ConvertFrom-Json).PSObject.Properties) { $values[$property.Name] = $property.Value }
    }
    foreach ($key in $Changes.Keys) { $values[$key] = $Changes[$key] }
    $temporary = Join-Path $directory ('services-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($temporary, ($values | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
        if (Test-Path -LiteralPath $configPath) { [IO.File]::Replace($temporary, $configPath, $null) }
        else { [IO.File]::Move($temporary, $configPath) }
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}
function Encrypt-Input([string]$Value) {
    $secure = ConvertTo-SecureString $Value -AsPlainText -Force
    try { return ConvertFrom-SecureString $secure } finally { $secure.Dispose() }
}
$form = New-Object Windows.Forms.Form
$form.Text = 'NBBOSS - 本机安全配置'
$form.Size = New-Object Drawing.Size(710, 650)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.Font = New-Object Drawing.Font('Microsoft YaHei UI', 10)
function Add-Label([string]$Text, [int]$Y, [int]$Height = 28) {
    $label = New-Object Windows.Forms.Label
    $label.Text = $Text
    $label.Location = New-Object Drawing.Point(22, $Y)
    $label.Size = New-Object Drawing.Size(650, $Height)
    $form.Controls.Add($label)
}
function Add-Input([string]$Label, [int]$Y, [bool]$Secret = $false) {
    $caption = New-Object Windows.Forms.Label
    $caption.Text = $Label
    $caption.Location = New-Object Drawing.Point(22, ($Y + 4))
    $caption.Size = New-Object Drawing.Size(155, 26)
    $form.Controls.Add($caption)
    $inputBox = New-Object Windows.Forms.TextBox
    $inputBox.Location = New-Object Drawing.Point(182, $Y)
    $inputBox.Size = New-Object Drawing.Size(480, 28)
    $inputBox.UseSystemPasswordChar = $Secret
    $form.Controls.Add($inputBox)
    return $inputBox
}
function Add-Button([string]$Text, [int]$X, [int]$Y, [scriptblock]$Handler) {
    $button = New-Object Windows.Forms.Button
    $button.Text = $Text
    $button.Location = New-Object Drawing.Point($X, $Y)
    $button.Size = New-Object Drawing.Size(205, 36)
    $button.Add_Click($Handler)
    $form.Controls.Add($button)
}
Add-Label '凭据仅保存到当前 Windows 用户的加密配置，不写入项目。' 18
Add-Label '保存不会重启服务或发送邮件。留空的服务保持原配置。' 48
Add-Label '一、网易 163 邮箱' 92
$senderBox = Add-Input '发件邮箱' 126
$senderBox.Text = $SenderEmail
$recipientBox = Add-Input '收件邮箱' 166
$recipientBox.Text = $RecipientEmail
$smtpBox = Add-Input 'SMTP 授权码' 206 $true
Add-Label '授权码不是邮箱登录密码。请在邮箱设置中开启 SMTP 后获取。' 245
Add-Button '打开网易邮箱' 22 281 { Start-Process 'https://mail.163.com/' }
$mailEnabled = New-Object Windows.Forms.CheckBox
$mailEnabled.Text = '启用邮件（重启后自动投递）'
$mailEnabled.Location = New-Object Drawing.Point(240, 287)
$mailEnabled.Size = New-Object Drawing.Size(210, 30)
$form.Controls.Add($mailEnabled)
if (Test-Path -LiteralPath $configPath) {
    $saved = [IO.File]::ReadAllText($configPath) | ConvertFrom-Json
    $mailEnabled.Checked = $saved.SMTP_ENABLED -eq 'true'
    if (!$SenderEmail) { $senderBox.Text = [string]$saved.SMTP_FROM }
    if (!$RecipientEmail) { $recipientBox.Text = [string]$saved.SMTP_TO }
}
Add-Button '保存邮箱配置' 457 281 {
    try {
        if ($senderBox.Text.Trim() -notmatch '^[^\s@]+@163\.com$') { throw '请填写有效的 163 发件地址。' }
        if ($recipientBox.Text.Trim() -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') { throw '请明确填写收件邮箱。' }
        if (!$smtpBox.Text.Trim()) { throw '请填写 SMTP 授权码。' }
        Save-Settings @{
            SMTP_HOST='smtp.163.com'; SMTP_PORT='465'; SMTP_USER=$senderBox.Text.Trim(); SMTP_FROM=$senderBox.Text.Trim(); SMTP_TO=$recipientBox.Text.Trim()
            SMTP_PASSWORD_DPAPI=(Encrypt-Input $smtpBox.Text.Trim()); SMTP_PROVIDER='smtp'; SMTP_ENABLED=$mailEnabled.Checked.ToString().ToLowerInvariant()
        }
        $smtpBox.Clear()
        $status.Text = '邮箱配置与启用状态已保存。重启 API 和 Worker 后生效。'
    } catch { [void][Windows.Forms.MessageBox]::Show('保存未完成。请检查邮箱、授权码及配置目录权限。', '配置提示') }
}
Add-Label '二、Tavily 联网搜索' 341
$searchBox = Add-Input 'Tavily API Key' 376 $true
Add-Label '登录 Tavily 控制台后创建 API Key，复制到上方密码框。' 416
Add-Button '打开 Tavily 控制台' 22 452 { Start-Process 'https://app.tavily.com/' }
Add-Button '保存搜索配置' 457 452 {
    try {
        if (!$searchBox.Text.Trim()) { throw '请填写 Tavily API Key。' }
        Save-Settings @{ SEARCH_API_KEY_DPAPI=(Encrypt-Input $searchBox.Text.Trim()); SEARCH_ENABLED='true'; SEARCH_PROVIDER='tavily' }
        $searchBox.Clear()
        $status.Text = '搜索配置已加密保存。重启 API 和 Worker 后生效。'
    } catch { [void][Windows.Forms.MessageBox]::Show('保存未完成。请检查 API Key 和配置目录权限。', '配置提示') }
}
$status = New-Object Windows.Forms.Label
$status.Text = '填写后分别点击保存。可以先完成其中一项，不必同时准备好。'
$status.Location = New-Object Drawing.Point(22, 510)
$status.Size = New-Object Drawing.Size(650, 70)
$status.ForeColor = [Drawing.Color]::DarkGreen
$form.Controls.Add($status)
if ($ValidateOnly) {
    if (!$smtpBox.UseSystemPasswordChar -or !$searchBox.UseSystemPasswordChar) { throw 'Secret fields must be masked.' }
    $form.Dispose()
    Write-Output 'Configuration form validation passed; no configuration was written.'
    exit 0
}
$form.Add_Shown({ $form.Activate() })
[void]$form.ShowDialog()
$smtpBox.Clear(); $searchBox.Clear(); $form.Dispose()

$ErrorActionPreference = 'Stop'

$launcher = Join-Path $PSScriptRoot 'start-dashboard.bat'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw 'Keep this script in the War Room folder beside start-dashboard.bat, then run it again.'
}

$iconPath = Join-Path $PSScriptRoot 'war-room.ico'
if (-not (Test-Path -LiteralPath $iconPath -PathType Leaf)) {
    throw "War Room icon not found: $iconPath"
}

$desktop = [Environment]::GetFolderPath('DesktopDirectory')
if (-not $desktop -or -not (Test-Path -LiteralPath $desktop -PathType Container)) {
    throw 'Windows could not find your desktop folder. No shortcut was created.'
}

$shortcutPath = Join-Path $desktop 'War Room.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
if ((Test-Path -LiteralPath $shortcutPath) -and $shortcut.TargetPath -ne $launcher) {
    throw 'A different War Room shortcut already exists. Rename or remove it, then run this script again.'
}

$shortcut.TargetPath = $launcher
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.Description = 'Start War Room and open the dashboard in your browser.'
$shortcut.IconLocation = "$iconPath,0"
$shortcut.Save()

Write-Host "Created desktop shortcut: $shortcutPath"
Write-Host 'Double-click War Room on your desktop to open the dashboard.'

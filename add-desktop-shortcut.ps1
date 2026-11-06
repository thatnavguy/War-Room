$ErrorActionPreference = 'Stop'

$launcher = Join-Path $PSScriptRoot 'start-dashboard.bat'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw 'Keep this script in the Mission Hall folder beside start-dashboard.bat, then run it again.'
}

$desktop = [Environment]::GetFolderPath('DesktopDirectory')
if (-not $desktop -or -not (Test-Path -LiteralPath $desktop -PathType Container)) {
    throw 'Windows could not find your desktop folder. No shortcut was created.'
}

$shortcutPath = Join-Path $desktop 'Mission Hall.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
if ((Test-Path -LiteralPath $shortcutPath) -and $shortcut.TargetPath -ne $launcher) {
    throw 'A different Mission Hall shortcut already exists. Rename or remove it, then run this script again.'
}

$shortcut.TargetPath = $launcher
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.Description = 'Start Mission Hall and open the dashboard in your browser.'
$shortcut.Save()

Write-Host "Created desktop shortcut: $shortcutPath"
Write-Host 'Double-click Mission Hall on your desktop to open the dashboard.'

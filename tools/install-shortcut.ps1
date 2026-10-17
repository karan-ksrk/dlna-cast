# Creates (or updates) a "dlna-cast" shortcut on your desktop that opens the app with no console window.
# Run again after moving the dlna-cast folder. Pass -StartMenu to also add it to the Start menu.
# Run: powershell -ExecutionPolicy Bypass -File tools\install-shortcut.ps1
param([switch]$StartMenu)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $root 'dlna-cast.vbs'
$icon = Join-Path $root 'assets\dlna-cast.ico'
foreach ($required in $launcher, $icon) {
  if (-not (Test-Path $required)) { throw "Missing $required" }
}

$shell = New-Object -ComObject WScript.Shell
$folders = @([Environment]::GetFolderPath('Desktop'))
if ($StartMenu) { $folders += [Environment]::GetFolderPath('Programs') }

foreach ($folder in $folders) {
  $path = Join-Path $folder 'dlna-cast.lnk'
  $shortcut = $shell.CreateShortcut($path)
  # wscript runs the launcher without a console; the launcher starts node hidden.
  $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
  $shortcut.Arguments = '"' + $launcher + '"'
  $shortcut.WorkingDirectory = $root
  $shortcut.IconLocation = "$icon,0"
  $shortcut.Description = 'Cast files or your screen to DLNA goggles and TVs'
  $shortcut.Save()
  "Created $path"
}

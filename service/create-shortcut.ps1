# Puts a "Local Collab" icon on the desktop that opens the notes in their own
# window (bin\open.mjs), with no console flash. Safe to re-run.

$ErrorActionPreference = "Stop"
$appDir = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$desktop = [Environment]::GetFolderPath("Desktop")
$path = Join-Path $desktop "Local Collab.lnk"

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($path)
# conhost --headless runs node without opening a console window.
$lnk.TargetPath = Join-Path $env:SystemRoot "System32\conhost.exe"
$lnk.Arguments = "--headless `"$node`" `"$(Join-Path $appDir 'bin\open.mjs')`""
$lnk.WorkingDirectory = $appDir
$lnk.IconLocation = "$(Join-Path $appDir 'assets\local-collab.ico'),0"
$lnk.Description = "Open Local Collab, the private ticket notes kept by Claude, ChatGPT and you"
$lnk.WindowStyle = 7
$lnk.Save()
Write-Output "Created $path"

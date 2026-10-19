# Registers Local Collab to start in the background whenever you log in to
# Windows, then starts it now. Runs as you, with no window and no admin rights.
# Remove it with service\uninstall.ps1.

$ErrorActionPreference = "Stop"
$TaskName = "Local Collab"

$appDir = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$supervisor = Join-Path $PSScriptRoot "supervise.mjs"
$user = "$env:USERDOMAIN\$env:USERNAME"

# conhost --headless runs the console program without opening a window.
$action = New-ScheduledTaskAction -Execute "conhost.exe" `
  -Argument "--headless `"$node`" `"$supervisor`"" `
  -WorkingDirectory $appDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
# No time limit (the default stops a task after 72 hours), keep running on
# battery, and retry if the launch itself fails. Crashes after launch are
# handled by supervise.mjs.
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force `
  -Description "Private notes server for ActiveCollab tickets at http://127.0.0.1:4317 ($appDir)" | Out-Null

Start-ScheduledTask -TaskName $TaskName
Write-Output "Registered and started '$TaskName'. It will start at every login."
& (Join-Path $PSScriptRoot "create-shortcut.ps1")
Write-Output "Open http://127.0.0.1:4317 ; logs are in $appDir\logs\server.log"

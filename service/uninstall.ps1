# Stops Local Collab and removes its login task. Notes are untouched.

$ErrorActionPreference = "Stop"
$TaskName = "Local Collab"
$appDir = Split-Path -Parent $PSScriptRoot

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Output "Removed the '$TaskName' login task."
}

# Stopping the task does not always stop its node processes, so end the ones
# running this app's supervisor or server.
$escaped = [regex]::Escape($appDir)
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -match $escaped -and $_.CommandLine -match 'supervise\.mjs|server\.mjs' } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force
    Write-Output "Stopped node process $($_.ProcessId)."
  }

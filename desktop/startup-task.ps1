param(
  [ValidateSet('Get', 'Enable', 'Disable')][string]$Action = 'Get',
  [Parameter(Mandatory = $true)][string]$ExpectedSupervisor,
  [string]$TaskName = 'Local Collab'
)
$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
if (-not $task) { @{ present = $false; managed = $false; enabled = $false } | ConvertTo-Json -Compress; exit }
$expected = [IO.Path]::GetFullPath($ExpectedSupervisor)
$root = Split-Path -Parent (Split-Path -Parent $expected)
$pattern = '^--headless\s+"[^"]*node\.exe"\s+"' + [regex]::Escape($expected) + '"$'
$managed = $task.Actions.Count -eq 1 -and
  (Split-Path -Leaf $task.Actions[0].Execute) -ieq 'conhost.exe' -and
  $task.Actions[0].Arguments -imatch $pattern -and
  $task.Actions[0].WorkingDirectory -ieq $root -and
  @($task.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' }).Count -gt 0
if ($Action -ne 'Get') {
  if (-not $managed) { throw 'This startup task belongs to another installation. It was left unchanged.' }
  if ($Action -eq 'Enable') {
    foreach ($trigger in $task.Triggers) {
      if ($trigger.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger') { $trigger.Enabled = $true }
    }
    Set-ScheduledTask -TaskName $TaskName -TaskPath '\' -Trigger $task.Triggers | Out-Null
    Enable-ScheduledTask -TaskName $TaskName -TaskPath '\' | Out-Null
  } else { Disable-ScheduledTask -TaskName $TaskName -TaskPath '\' | Out-Null }
  $task = Get-ScheduledTask -TaskName $TaskName -TaskPath '\'
}
$enabled = $task.Settings.Enabled -and @($task.Triggers | Where-Object {
  $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' -and $_.Enabled
}).Count -gt 0
@{ present = $true; managed = [bool]$managed; enabled = [bool]$enabled } | ConvertTo-Json -Compress

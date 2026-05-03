$action = New-ScheduledTaskAction -Execute 'C:\dev\mcp-tools\mevoric\start-runner.bat'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Days 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -Hidden
Register-ScheduledTask -TaskName 'Mevoric Runner' -Action $action -Trigger $trigger -Settings $settings -Description 'Mevoric runner handles real work delegated to PC agents (no fake replies)' -Force | Out-Null
Write-Host 'Re-registered. Starting now...'
Start-ScheduledTask -TaskName 'Mevoric Runner'
Start-Sleep -Seconds 4
$proc = Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -like '*runner.mjs*' }
if ($proc) {
  Write-Host "RUNNER ALIVE - PID $($proc.ProcessId)"
} else {
  Write-Host 'RUNNER NOT FOUND'
}

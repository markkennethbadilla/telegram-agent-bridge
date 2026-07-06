# Registers a hidden scheduled task that keeps the bridge running (at logon + now).
# Idempotent: re-running re-points the same task.
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$TaskName = 'TelegramAgentBridge'

$bun = (Get-Command bun.exe -ErrorAction SilentlyContinue).Source
if (-not $bun) { $bun = Join-Path $env:USERPROFILE '.bun\bin\bun.exe' }
if (-not (Test-Path $bun)) { throw 'bun.exe not found' }

# loop wrapper: restart on crash, small backoff
$loop = @"
Set-Location '$Here'
while (`$true) {
  & '$bun' src/bot.ts 2>> "`$env:LOCALAPPDATA\telegram-agent-bridge\bridge.err.log"
  Start-Sleep -Seconds 10
}
"@
$loopPath = Join-Path $env:LOCALAPPDATA 'telegram-agent-bridge\bridge-loop.ps1'
New-Item -ItemType Directory -Force (Split-Path $loopPath) | Out-Null
Set-Content -Path $loopPath -Value $loop -Encoding UTF8

$psExe = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
if (-not $psExe) { $psExe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" }
$action = New-ScheduledTaskAction -Execute $psExe `
  -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $loopPath)
# two triggers: at-logon (boot path) + hourly watchdog (revives a killed loop; the
# loop script itself is single-instance-safe because Telegram rejects a second poller
# and bot.ts exits, so a duplicate start converges to one live instance)
$trigLogon = New-ScheduledTaskTrigger -AtLogOn
$trigHourly = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) `
    -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration ([TimeSpan]::MaxValue)
$trigger = @($trigLogon, $trigHourly)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "[bridge] task '$TaskName' registered and started (hidden, at-logon, crash-restart loop)"

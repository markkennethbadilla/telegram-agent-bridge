# Registers the hidden, self-healing autostart for the Telegram bridge.
# Idempotent: re-running re-points the same tasks (never stacks).
#
# THREE layers keep it alive (defense in depth):
#   1. bridge-loop.ps1  - a while($true) wrapper that relaunches bot.ts on crash (10s backoff).
#   2. TelegramAgentBridge task - runs the loop windowless (via wscript) at logon + every 5 min.
#   3. TelegramAgentBridgeWatchdog task - every 5 min, if no bun bot.ts process is alive,
#      (re)starts layer 2. Kill the loop AND the task and this still revives everything.
# Single-instance is safe: bot.ts holds a 127.0.0.1 port lock, so a duplicate start exits 0.
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$TaskName = 'TelegramAgentBridge'
$WatchName = 'TelegramAgentBridgeWatchdog'
$AppDir = Join-Path $env:LOCALAPPDATA 'telegram-agent-bridge'
New-Item -ItemType Directory -Force $AppDir | Out-Null

$bun = (Get-Command bun.exe -ErrorAction SilentlyContinue).Source
if (-not $bun) { $bun = Join-Path $env:USERPROFILE '.bun\bin\bun.exe' }
if (-not (Test-Path $bun)) { throw 'bun.exe not found' }

$psExe = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
if (-not $psExe) { $psExe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" }

# --- layer 1: the crash-restart loop ---
$loop = @"
Set-Location '$Here'
while (`$true) {
  & '$bun' src/bot.ts 2>> "$AppDir\bridge.err.log"
  Start-Sleep -Seconds 10
}
"@
$loopPath = Join-Path $AppDir 'bridge-loop.ps1'
Set-Content -Path $loopPath -Value $loop -Encoding UTF8

# Truly-windowless launcher. pwsh -WindowStyle Hidden STILL allocates a killable console;
# wscript Run(cmd,0,False) starts the loop with NO console at all.
$q = [char]34
$cmd = "$q$psExe$q -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $q$loopPath$q"
$cmdEsc = $cmd -replace $q, ($q + $q)   # VBScript escapes " as ""
$vbs = @"
Set sh = CreateObject("WScript.Shell")
sh.Run "$cmdEsc", 0, False
"@
$vbsPath = Join-Path $AppDir 'run-hidden.vbs'
Set-Content -Path $vbsPath -Value $vbs -Encoding ASCII

# --- layer 3: the watchdog script (revives the main task if no bot.ts is alive) ---
$watch = @"
`$alive = Get-CimInstance Win32_Process -Filter "Name='bun.exe'" -ErrorAction SilentlyContinue |
  Where-Object { `$_.CommandLine -match 'src[\/]bot\.ts' }
if (-not `$alive) { Start-ScheduledTask -TaskName '$TaskName' }
"@
$watchPath = Join-Path $AppDir 'watchdog.ps1'
Set-Content -Path $watchPath -Value $watch -Encoding UTF8

# Shared settings: survive battery, no time limit, task-level restart on failure.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew -StartWhenAvailable

# ── main bridge task: windowless loop, at logon + 5-min self-heal ──
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument ('"{0}"' -f $vbsPath)
$trigLogon = New-ScheduledTaskTrigger -AtLogOn
$trig5 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($trigLogon, $trig5) -Settings $settings | Out-Null

# ── watchdog task: every 5 min, revive the main task if the bridge process is gone ──
$watchAction = New-ScheduledTaskAction -Execute $psExe `
  -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $watchPath)
$watchTrig = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
Unregister-ScheduledTask -TaskName $WatchName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $WatchName -Action $watchAction -Trigger $watchTrig -Settings $settings | Out-Null

Start-ScheduledTask -TaskName $TaskName
Write-Host "[bridge] '$TaskName' + '$WatchName' registered (windowless, at-logon, 5-min self-heal x2, started)"

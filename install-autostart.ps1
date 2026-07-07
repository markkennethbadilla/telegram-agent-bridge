# Registers the hidden, self-healing autostart for the Telegram bridge.
# Idempotent: re-running re-points the same tasks (never stacks).
#
# THREE layers keep it alive (defense in depth):
#   1. bridge-loop.ps1  - a while($true) wrapper that relaunches bot.ts on crash (10s backoff).
#   2. TelegramAgentBridge task - runs the loop windowless (via wscript) at logon + every 5 min.
#   3. TelegramAgentBridgeWatchdog task - every 5 min, if no bun bot.ts process is alive,
#      (re)starts layer 2. Kill the loop AND the task and this still revives everything.
# Single-instance: the loop holds a named mutex (below) so only one loop runs; bot.ts also
# holds a 127.0.0.1 port lock as a second backstop. Both are needed - the port lock alone
# has a sub-second startup race when two loops launch at once (at-logon + watchdog).
$ErrorActionPreference = 'Stop'

# Self-elevate: the main task uses an -AtLogOn trigger, which the scheduler rejects with
# "Access is denied" when Register-ScheduledTask runs non-elevated (and a reprovision may
# invoke this child unelevated). Inbox sudo is UAC-never-notify => silent. Mirrors
# 03-agents-provisioning/steps/install_task_hidden_watcher.ps1.
$isAdmin = ([Security.Principal.WindowsPrincipal]::new(
             [Security.Principal.WindowsIdentity]::GetCurrent()
           )).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $isAdmin) {
  $sudo = Get-Command sudo.exe -ErrorAction SilentlyContinue
  if ($sudo) { & sudo.exe pwsh -NoProfile -ExecutionPolicy Bypass -File $MyInvocation.MyCommand.Path @args; exit $LASTEXITCODE }
  Write-Warning '[bridge] not elevated and sudo.exe missing - AtLogOn task registration may be denied'
}
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
# Single-instance: at-logon + 5-min repetition + watchdog can each launch a loop.
# A named mutex proved unreliable here - an abandoned-mutex takeover let a second loop
# coexist, so idle loops piled up (each harmlessly losing bot.ts's port lock, but churning).
# Instead bind a loop-guard TCP port: the OS grants it to exactly one process. Can't bind
# => another loop already owns it => exit. Same primitive bot.ts uses for its poller lock.
`$guard = `$null
try {
  `$guard = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 48764)
  `$guard.ExclusiveAddressUse = `$true
  `$guard.Start()
} catch { exit 0 }
while (`$true) {
  if (-not `$guard.Server.IsBound) { exit 0 }  # guard released => another loop owns it
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

# Windowless launcher for the watchdog (pwsh -WindowStyle Hidden STILL flashes a
# console every 5 min; wscript Run(cmd,0,False) gives it no console at all).
$watchCmd = "$q$psExe$q -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $q$watchPath$q"
$watchCmdEsc = $watchCmd -replace $q, ($q + $q)
$watchVbs = @"
Set sh = CreateObject("WScript.Shell")
sh.Run "$watchCmdEsc", 0, False
"@
$watchVbsPath = Join-Path $AppDir 'watchdog-hidden.vbs'
Set-Content -Path $watchVbsPath -Value $watchVbs -Encoding ASCII

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
$watchAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument ('"{0}"' -f $watchVbsPath)
$watchTrig = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
Unregister-ScheduledTask -TaskName $WatchName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $WatchName -Action $watchAction -Trigger $watchTrig -Settings $settings | Out-Null

# VERIFY the tasks actually registered before claiming success. Register-ScheduledTask
# throws "Access is denied" on the -AtLogOn trigger when non-elevated; the old
# unconditional success line then LIED that both registered. Fail loudly instead.
$haveMain  = [bool](Get-ScheduledTask -TaskName $TaskName  -ErrorAction SilentlyContinue)
$haveWatch = [bool](Get-ScheduledTask -TaskName $WatchName -ErrorAction SilentlyContinue)
if (-not ($haveMain -and $haveWatch)) {
  throw "[bridge] task registration FAILED (main=$haveMain watchdog=$haveWatch) - likely not elevated; re-run elevated"
}
Start-ScheduledTask -TaskName $TaskName
Write-Host "[bridge] '$TaskName' + '$WatchName' registered (windowless, at-logon, 5-min self-heal x2, started)"

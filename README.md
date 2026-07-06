# telegram-agent-bridge

Drive CLI coding agents (Claude Code, OpenCode, Antigravity, Hermes, or a raw
PowerShell) from Telegram — on your phone, from nothing. No terminal, no tmux, no
WSL. Spawn a session, chat with it, watch its tool calls stream live, send it files
and get screenshots back — all in a Telegram chat.

## Overview
- **Native Windows.** Runs agents as headless one-shot CLI turns (`claude -p`, `opencode run`, `pwsh -Command`) — no TUI scraping, so no tmux and no WSL. Every agent-agnostic alternative needs tmux (Unix-only); every native one is Claude-only (see `PRIOR-ART.md`).
- **Spawn from your phone.** `/new claude <dir>` creates a session from scratch. No pre-existing terminal to attach to.
- **One session per chat/topic.** Each Telegram chat — and each Topic in a group — is its own independent, resumable conversation.
- **Live progress.** Claude turns stream their tool calls (Bash, Edit, Grep…) into a status message that updates in place, then post the final answer.
- **File round-trips.** Send a photo/document → it lands in the agent's working directory and the agent looks at it. Images the agent produces (chrome-devtools screenshots, charts) come back inline.
- **Private.** Long polling only — no open ports, no webhook. A numeric user-ID allowlist drops everyone else silently.

## Architecture
- `src/bot.ts` — grammY long-polling bot. Command router (case-insensitive), per-`chatId:threadId` sessions, allowlist, 4000-char reply chunking, the live-status streaming, and the file round-trip handlers. A `127.0.0.1` port lock makes a second instance exit cleanly (two pollers on one token would 409-fight).
- `src/agents.ts` — one adapter function per agent, each running a headless CLI turn:
  - `claude` — `claude -p --output-format {json | stream-json} [--model <m>] [--resume <id>]`. Streams tool-use events when a live listener is attached; the session id is parsed back so conversations continue turn to turn.
  - `opencode` — `opencode run [--continue]`
  - `agy` — `agy --print` (Antigravity)
  - `hermes` — `hermes -z <msg> --dev`
  - `shell` — `pwsh -NoProfile -NonInteractive -Command`
  - A shared `runStream`/`run` spawns the process, enforces `TURN_TIMEOUT_MS` (default 10 min), and registers the live child on the session so `/stop` can kill it.
- `src/store.ts` — sessions persisted to `%LOCALAPPDATA%\telegram-agent-bridge\sessions.json` (runtime-only fields like the live process handle are stripped before write). Corrupt state is discarded, never fatal.

## Setup
1. Create a bot: message **@BotFather** → `/newbot` → copy the token.
2. Get your numeric id from **@userinfobot**.
3. Write `.env` in the repo root:
   ```
   TELEGRAM_BOT_TOKEN=123:abc
   ALLOWED_USER_IDS=7788663636
   BRIDGE_DEFAULT_DIR=D:\repositories-per-account\...   # where /new defaults
   ```
4. `bun install`
5. Foreground: `bun start` — or install the always-on background service: `install-autostart.ps1` (elevated).

On an estate-provisioned machine, all of the above is one command:
`03-agents-provisioning/steps/install-telegram-agent-bridge.ps1` (control-room) —
it clones/pulls, `bun install`s, writes `.env` from the credential vault, and runs
`install-autostart.ps1`.

## Commands
Sent from Telegram. **Case-insensitive** (`/Fresh` == `/fresh`); a `@botname` suffix is ignored. The `/` menu is registered on startup and always matches these exactly.

| Command | Does |
|---|---|
| `/new <agent> [dir]` | spawn a session (dir defaults to `BRIDGE_DEFAULT_DIR`) |
| `/ls` | list active sessions |
| `/agent <name>` | switch agent, keep the dir (resets the conversation) |
| `/model <opus\|sonnet\|haiku\|id>` | pick the claude model for this session |
| `/pwd` | show the session's working directory |
| `/cd <dir>` | change the working directory |
| `/stop` | stop the running turn, keep the session |
| `/fresh` | reset the conversation (keep agent + dir) |
| `/end` | kill the session |
| `/help` | show this list |

Plus: **send a plain message** = one agent turn. **Send a photo/file** = it's saved into the agent's cwd and the agent examines it (your caption becomes the prompt).

## Reliability model — always on, self-healing
Three layers of defense, so the bridge survives crashes, closed terminals, and reboots:
1. **Crash loop** — `bridge-loop.ps1` is a `while($true)` wrapper that relaunches `bot.ts` 10s after any exit. `bot.ts` exits nonzero on any unhandled error, so recovery is total.
2. **Main task** `TelegramAgentBridge` — runs the loop **windowless** (via `wscript run-hidden.vbs`, so there is no console to close) at logon and re-checks every 5 minutes.
3. **Watchdog task** `TelegramAgentBridgeWatchdog` — every 5 minutes, if no `bun bot.ts` process is alive, it (re)starts the main task. Kill the process, the loop, *and* the main task, and this still revives everything within 5 minutes.

Single-instance is safe throughout: `bot.ts` holds a `127.0.0.1` port lock, so any duplicate start exits 0. Network down at boot just means the loop retries every 10s until Telegram is reachable.

**Known limits:** the machine must be powered on and logged in. One turn at a time per session. One bot token = one running bridge (Telegram allows a single long-poll consumer) — a second machine needs its own token.

## Second machine
One token supports one bridge. Per additional machine:
1. @BotFather → `/newbot` → copy the new token.
2. Install `bun` + the agent CLIs you want.
3. `git clone … && cd telegram-agent-bridge && bun install`
4. Write `.env` (new token, same `ALLOWED_USER_IDS`).
5. `install-autostart.ps1` (elevated).

## Agent reliability
- **claude, agy, shell** — solid, repeatedly E2E-proven.
- **opencode** — wired; test on a box where it's installed.
- **hermes** — works but flaky under the scheduled-task environment (turns can hang). The `TURN_TIMEOUT_MS` guard kills a hung turn and replies with an error so it can't wedge the session. Prefer claude/agy for real work.

## Troubleshooting
- **Bot silent** → your numeric id isn't in `ALLOWED_USER_IDS` (strangers are dropped by design).
- **"Still working"** → one turn per session; wait, or `/stop`, or `/end` + `/new`.
- **Command shows "not available"** → stale menu from a token reused across bots; a restart re-registers the correct list via `setMyCommands`.
- **Menu missing new commands** → same fix; the menu is derived from the command table on startup.
- **Nothing revives after a kill** → check both tasks exist: `Get-ScheduledTask TelegramAgentBridge*`; re-run `install-autostart.ps1` elevated.

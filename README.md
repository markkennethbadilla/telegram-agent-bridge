# telegram-agent-bridge

## Overview
Native-Windows Telegram bridge for CLI coding agents. Spawn a brand-new agent session from your phone (no pre-existing terminal needed), chat with it, and keep separate parallel sessions per Telegram chat/topic. Agent-agnostic: Claude Code, OpenCode, or a raw PowerShell all work through the same bot.

Built because every existing agent-agnostic bridge (ccgram, ccc, tmux bots) requires tmux and therefore WSL; this runs headless agent commands natively instead of scraping a TUI.

## Architecture
- `src/bot.ts` — grammY bot, long polling (no ports/webhooks). One session per `chatId:threadId`; user-ID whitelist; 4000-char reply chunking; typing indicator while an agent runs.
- `src/agents.ts` — adapters. Each agent = one function running a headless CLI turn:
  - `claude` → `claude -p --output-format json --dangerously-skip-permissions [--resume <id>]` (session id parsed from JSON, so conversations continue turn to turn)
  - `opencode` → `opencode run [--continue]`
  - `shell` → `pwsh -NoProfile -NonInteractive -Command`
- `src/store.ts` — sessions persisted to `%LOCALAPPDATA%\telegram-agent-bridge\sessions.json` so restarts keep resumability.

## Setup
1. Create a bot: message @BotFather → `/newbot` → copy token.
2. Get your numeric user id (@userinfobot).
3. `.env` in repo root:
   ```
   TELEGRAM_BOT_TOKEN=123:abc
   ALLOWED_USER_IDS=123456789
   ```
4. `bun install && bun start`

## Usage (from Telegram)
- `/new claude D:\repositories-per-account\...\some-repo` — spawn a session from nothing
- send plain messages — each is one agent turn, reply comes back when done
- `/fresh` — reset the conversation (same agent/dir)
- `/ls`, `/end`
- In a group with Topics enabled, each topic is its own independent session.

## Runbook
- Run in foreground: `bun start` (repo root).
- Autostart: hidden Task Scheduler task running `bun src/bot.ts` (see estate rule: no Startup folder).
- Logs: stdout; errors also sent back into the Telegram chat.


## Setting up on another machine
One bot token supports ONE running bridge (Telegram allows a single long-poll consumer;
two machines on the same token fight with 409s). So per additional machine:
1. @BotFather -> /newbot -> copy the new token (2 minutes, one time).
2. Install bun + the agent CLIs you want (claude/opencode).
3. `git clone https://github.com/markkennethbadilla/telegram-agent-bridge && cd telegram-agent-bridge && bun install`
4. Write `.env` (new token + your same ALLOWED_USER_IDS).
5. Run `install-autostart.ps1` elevated (or via sudo) — registers the hidden at-logon task.
On an estate-provisioned machine, steps 2-5 are one command:
`03-agents-provisioning/steps/install-telegram-agent-bridge.ps1` (control-room).

## Reliability model
- Autostart: Task Scheduler at-logon task (survives reboots; starts after you log in).
- Crash recovery: outer pwsh loop relaunches bun 10s after any exit; bot.ts exits nonzero
  on any unhandled error so recovery is total, not partial.
- Network down at boot: launch fails -> loop retries every 10s until Telegram is reachable.
- State: sessions.json in %LOCALAPPDATA%; corrupt state is discarded, not fatal.
- Known limits: the machine must be powered on and logged in; turns are end-of-turn replies
  (no streaming); one turn at a time per session.

## Troubleshooting
- Bot silent → check ALLOWED_USER_IDS matches your numeric id (strangers are dropped silently by design).
- "Still working" → one turn per session at a time; wait or /end and /new.
- Claude errors about hooks/permissions → the bridge runs with `--dangerously-skip-permissions`; estate Stop-hooks may lengthen turns but do not block headless runs.

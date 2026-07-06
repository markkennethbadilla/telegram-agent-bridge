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

## Troubleshooting
- Bot silent → check ALLOWED_USER_IDS matches your numeric id (strangers are dropped silently by design).
- "Still working" → one turn per session at a time; wait or /end and /new.
- Claude errors about hooks/permissions → the bridge runs with `--dangerously-skip-permissions`; estate Stop-hooks may lengthen turns but do not block headless runs.

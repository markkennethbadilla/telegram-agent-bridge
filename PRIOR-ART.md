# Prior art

Hunted 2026-07-06 (browser-verified, not memory) before building.

| Candidate | Verdict |
|---|---|
| Official Claude Code remote control / Telegram channel plugin | Attach-only: cannot spawn a new session from nothing (open FR anthropics/claude-plugins-official#878). Claude-only. |
| ccgram (alexei-led/ccgram) | Best in class, agent-agnostic, spawns from phone — but sits on tmux/herdr, Unix-only. Mark requires native Windows, no WSL. |
| ccc (kidandcat/ccc) | Spawns sessions via /new, rich Claude integration — Claude-only and macOS/Linux/WSL. |
| terranc/claude-telegram-bot-bridge | Claude SDK only, macOS launchd daemon tooling. |

**Verdict: no equivalent exists** — every agent-agnostic bridge requires tmux (hence WSL on Windows); every native-runnable one is Claude-only. Built the minimal native-Windows, agent-agnostic bridge instead: headless CLI turns (`claude -p --resume`, `opencode run --continue`, pwsh) per Telegram chat/topic, grammY long polling.

Re-check before extending: if ccgram gains a native-Windows multiplexer backend, adopt it and retire this.

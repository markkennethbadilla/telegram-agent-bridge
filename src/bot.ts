// Telegram <-> CLI-agent bridge. One session per chat/topic; spawn agents from nothing.
// Long polling only: no ports, no webhooks, no exposure.
import { Bot } from "grammy";
import { agents, type Session } from "./agents";
import { loadSessions, saveSessions } from "./store";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const token = process.env.TELEGRAM_BOT_TOKEN;
const allowed = (process.env.ALLOWED_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (!token || allowed.length === 0) {
  console.error("Set TELEGRAM_BOT_TOKEN and ALLOWED_USER_IDS in .env");
  process.exit(1);
}

// single-instance lock: two pollers on one bot token livelock getUpdates (409 fight,
// neither consumes). A duplicate start must die instantly, not fight.
try {
  Bun.listen({ hostname: "127.0.0.1", port: Number(process.env.BRIDGE_LOCK_PORT ?? 48765), socket: { data() {} } });
} catch {
  console.error("another bridge instance holds the lock - exiting");
  process.exit(0);
}

const sessions = loadSessions(); // key: `${chatId}:${threadId ?? 0}`
const bot = new Bot(token);

bot.use((ctx, next) => {
  if (!ctx.from || !allowed.includes(String(ctx.from.id))) return; // silent drop for strangers
  return next();
});

const key = (ctx: { chat?: { id: number }; message?: { message_thread_id?: number } }) =>
  `${ctx.chat?.id}:${ctx.message?.message_thread_id ?? 0}`;

const IMG = /\.(png|jpe?g|gif|webp)$/i;
// Snapshot image files (name -> mtimeMs) so we can diff before/after a turn and send
// back only what the agent freshly produced (chrome-devtools screenshots, charts, …).
function snapImages(dir: string): Map<string, number> {
  const m = new Map<string, number>();
  try {
    for (const f of readdirSync(dir)) {
      if (!IMG.test(f)) continue;
      try { m.set(f, statSync(join(dir, f)).mtimeMs); } catch {}
    }
  } catch {}
  return m;
}

async function reply(ctx: any, text: string) {
  const opts = ctx.message?.message_thread_id ? { message_thread_id: ctx.message.message_thread_id } : {};
  for (let i = 0; i < text.length; i += 4000) {
    await ctx.reply(text.slice(i, i + 4000) || "(empty)", opts);
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────
// ONE source of truth: this table drives both the /command router (below) and the
// Telegram menu (setMyCommands in onStart), so the menu can never drift from what
// actually works. Command matching is case-insensitive (/Fresh == /fresh).
type Cmd = { name: string; menu: string; run: (ctx: any, arg: string) => Promise<any> | any };

const COMMANDS: Cmd[] = [
  {
    name: "new", menu: "spawn a session: /new <agent> [dir]",
    run: (ctx, arg) => {
      const [agentRaw, ...dirParts] = arg.trim().split(/\s+/);
      const agent = (agentRaw ?? "").toLowerCase();  // agent names are case-insensitive
      const dir = dirParts.join(" ") || process.env.BRIDGE_DEFAULT_DIR || "";
      if (!agent || !dir || !agents[agent]) {
        return reply(ctx, `Usage: /new <agent> [dir] (default: ${process.env.BRIDGE_DEFAULT_DIR ?? "none set"})\nAgents: ${Object.keys(agents).join(", ")}`);
      }
      sessions.set(key(ctx), { agent, dir, busy: false });
      saveSessions(sessions);
      return reply(ctx, `Session ready: ${agent} @ ${dir}\nJust send messages now.`);
    },
  },
  {
    name: "ls", menu: "list active sessions",
    run: (ctx) => {
      const lines = [...sessions.entries()].map(([k, s]) => `${k} -> ${s.agent} @ ${s.dir}${s.busy ? " (busy)" : ""}`);
      return reply(ctx, lines.join("\n") || "No sessions. /new <agent> <dir>");
    },
  },
  {
    name: "agent", menu: "switch agent, keep the dir: /agent <name>",
    run: (ctx, arg) => {
      const s = sessions.get(key(ctx));
      if (!s) return reply(ctx, "No session here. /new <agent> <dir> first.");
      const name = arg.trim().toLowerCase();  // agent names are case-insensitive
      if (!name) return reply(ctx, `Current agent: ${s.agent}\nAgents: ${Object.keys(agents).join(", ")}`);
      if (!agents[name]) return reply(ctx, `Unknown agent "${name}". Agents: ${Object.keys(agents).join(", ")}`);
      s.agent = name; s.resumeId = undefined; saveSessions(sessions); // new agent -> fresh conversation
      return reply(ctx, `Agent switched to ${name} (conversation reset, same dir).`);
    },
  },
  {
    name: "model", menu: "pick claude model: opus|sonnet|haiku",
    run: (ctx, arg) => {
      const s = sessions.get(key(ctx));
      if (!s) return reply(ctx, "No session here. /new <agent> <dir> first.");
      if (!arg.trim()) return reply(ctx, `Current model: ${s.model ?? "default (account)"}\nUsage: /model opus | sonnet | haiku | <full-id>`);
      s.model = arg.trim(); saveSessions(sessions);
      return reply(ctx, `Model set to ${arg.trim()} (applies to the next message).`);
    },
  },
  {
    name: "pwd", menu: "show the session's working directory",
    run: (ctx) => {
      const s = sessions.get(key(ctx));
      return reply(ctx, s ? `${s.agent} @ ${s.dir}` : "No session here.");
    },
  },
  {
    name: "cd", menu: "change working directory: /cd <dir>",
    run: (ctx, arg) => {
      const s = sessions.get(key(ctx));
      if (!s) return reply(ctx, "No session here. /new <agent> <dir> first.");
      const dir = arg.trim();
      if (!dir) return reply(ctx, `Current dir: ${s.dir}\nUsage: /cd <dir>`);
      if (!existsSync(dir)) return reply(ctx, `No such directory: ${dir}`);
      s.dir = dir; saveSessions(sessions);
      return reply(ctx, `Working directory: ${dir}`);
    },
  },
  {
    name: "stop", menu: "stop the running turn (keep the session)",
    run: (ctx) => {
      const s = sessions.get(key(ctx));
      if (!s?.proc) return reply(ctx, "Nothing running.");
      try { s.proc.kill(); } catch {}
      s.proc = undefined; s.busy = false;
      return reply(ctx, "Stopped.");
    },
  },
  {
    name: "fresh", menu: "reset the conversation (keep agent+dir)",
    run: (ctx) => {
      const s = sessions.get(key(ctx));
      if (s) { s.resumeId = undefined; saveSessions(sessions); }
      return reply(ctx, s ? "Conversation reset (same agent/dir)." : "No session here.");
    },
  },
  {
    name: "end", menu: "kill this session",
    run: (ctx) => {
      const s = sessions.get(key(ctx));
      if (s?.proc) { try { s.proc.kill(); } catch {} }
      sessions.delete(key(ctx)); saveSessions(sessions);
      return reply(ctx, "Session ended.");
    },
  },
  {
    name: "help", menu: "show this help",
    run: (ctx) => reply(ctx, helpText()),
  },
];

const BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));
function helpText(): string {
  return "CLI-agent bridge. Commands (case-insensitive):\n" +
    COMMANDS.map((c) => `/${c.name} - ${c.menu}`).join("\n") +
    "\n\nSend a photo/file to drop it in the agent's cwd; images the agent makes come back here.";
}

// Single case-insensitive command router: parses "/<cmd>[@bot] [args]", lowercases the
// command, dispatches from the table. Unknown commands get a clear hint (never silent).
bot.on("::bot_command", async (ctx) => {
  const text = ctx.message?.text ?? ctx.channelPost?.text ?? "";
  const m = text.match(/^\/([A-Za-z0-9_]+)(?:@\S+)?\s*([\s\S]*)$/);
  if (!m) return;
  const cmd = BY_NAME.get(m[1].toLowerCase());
  if (!cmd) return reply(ctx, `Unknown command /${m[1]}. Try /help`);
  await cmd.run(ctx, m[2] ?? "");
});
// /start is an alias for /help (Telegram sends it on first open)
bot.command("start", (ctx) => reply(ctx, helpText()));

// One agent turn: busy-guard, live-streamed status message, then send back the answer
// plus any image files the agent freshly produced in its cwd (F: screenshot round-trip).
async function runTurn(ctx: any, s: Session, prompt: string) {
  if (s.busy) return reply(ctx, "Still working on the previous message - hold on.");
  s.busy = true;
  const typing = setInterval(() => ctx.replyWithChatAction("typing").catch(() => {}), 5000);
  ctx.replyWithChatAction("typing").catch(() => {});
  const opts = ctx.message?.message_thread_id ? { message_thread_id: ctx.message.message_thread_id } : {};
  const before = snapImages(s.dir);
  let statusMsg: any = null, steps: string[] = [], lastEdit = 0, pending = false;
  const flush = async () => {
    if (!statusMsg || pending) return;
    pending = true;
    const body = steps.slice(-12).join("\n") + "\n\n...working";
    try { await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, body, opts); } catch {}
    lastEdit = Date.now(); pending = false;
  };
  const onEvent = (label: string) => {
    steps.push(label);
    if (Date.now() - lastEdit > 1200) void flush();   // throttle: Telegram ~1 edit/sec
  };
  try {
    statusMsg = await ctx.reply("...working", opts).catch(() => null);
    const r = await agents[s.agent](prompt, s, onEvent);
    s.resumeId = r.resumeId ?? s.resumeId;
    saveSessions(sessions);
    const answer = r.text.trim() || "(empty response)";
    if (statusMsg) { try { await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id); } catch {} }
    await reply(ctx, answer);
    // send back new/modified images (chrome-devtools screenshots, charts, ...), newest first, cap 5
    const after = snapImages(s.dir);
    const fresh = [...after].filter(([f, m]) => before.get(f) !== m).sort((a, b) => b[1] - a[1]).slice(0, 5);
    for (const [f] of fresh) {
      try {
        const { InputFile } = await import("grammy");
        await ctx.replyWithPhoto(new InputFile(join(s.dir, f)), { caption: f, ...opts });
      } catch (e: any) { await reply(ctx, `(couldn't send ${f}: ${e.message})`); }
    }
  } catch (e: any) {
    await reply(ctx, `Error: ${e.message}`);
  } finally {
    clearInterval(typing);
    s.busy = false;
  }
}

bot.on("message:text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) return; // commands are handled by the router above
  const s = sessions.get(key(ctx));
  if (!s) return reply(ctx, "No session in this chat/topic. /new <agent> <dir>");
  await runTurn(ctx, s, ctx.message.text);
});

// Inbound file/photo -> download into the session cwd, then run the agent on it (F).
bot.on([":photo", ":document"], async (ctx) => {
  const s = sessions.get(key(ctx));
  if (!s) return reply(ctx, "No session here. /new <agent> <dir> first.");
  try {
    const file = await ctx.getFile(); // largest photo size / the document
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const doc: any = ctx.message?.document;
    const photo = ctx.message?.photo?.at(-1);
    const name = doc?.file_name ?? (photo ? `photo_${file.file_unique_id}.jpg` : (file.file_path?.split("/").pop() ?? `file_${file.file_unique_id}`));
    const dest = join(s.dir, name);
    const buf = await (await fetch(url)).arrayBuffer();
    await Bun.write(dest, buf);
    const caption = (ctx.message?.caption ?? "").trim();
    await reply(ctx, `Saved ${name} to ${s.dir}`);
    await runTurn(ctx, s, caption || `I just added the file "${name}" to your working directory. Take a look at it and tell me what it is.`);
  } catch (e: any) {
    await reply(ctx, `Couldn't save the file: ${e.message}`);
  }
});

bot.catch((e) => {
  const err: any = e.error;
  // 409 Conflict = another poller holds this token's getUpdates. A duplicate must DIE,
  // not fight (two pollers livelock and neither drains updates). Exit 0 so the autostart
  // loop's single-instance guards converge to exactly one live poller.
  if (err && (err.error_code === 409 || String(err?.description ?? "").includes("Conflict"))) {
    console.error("409 Conflict - another bridge instance is polling; exiting");
    process.exit(0);
  }
  console.error("bot error:", err);
});
// any escaped failure -> exit nonzero so the autostart loop relaunches us clean
process.on("unhandledRejection", (e) => { console.error("fatal:", e); process.exit(1); });
process.on("uncaughtException", (e) => { console.error("fatal:", e); process.exit(1); });
console.error("bridge up — long polling");
// Telegram's /command menu is DERIVED from the COMMANDS table, so it can never drift
// from the handlers. setMyCommands REPLACES the whole list, purging any stale commands
// (e.g. a previous bot's /status) that showed "not available". Telegram caps descriptions
// at 256 chars and requires lowercase command names, which our table already satisfies.
const MENU = COMMANDS.map((c) => ({ command: c.name, description: c.menu }));

bot.start({
  onStart: async (me) => {
    console.error("polling as", me.username);
    try { await bot.api.setMyCommands(MENU); } catch (e) { console.error("setMyCommands failed:", e); }
  },
});

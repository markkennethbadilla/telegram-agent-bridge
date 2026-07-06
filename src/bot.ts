// Telegram <-> CLI-agent bridge. One session per chat/topic; spawn agents from nothing.
// Long polling only: no ports, no webhooks, no exposure.
import { Bot } from "grammy";
import { agents, type Session } from "./agents";
import { loadSessions, saveSessions } from "./store";
import { readdirSync, statSync } from "node:fs";
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

bot.command("new", async (ctx) => {
  const [agent, ...dirParts] = (ctx.match as string).trim().split(/\s+/);
  const dir = dirParts.join(" ") || process.env.BRIDGE_DEFAULT_DIR || "";
  if (!agent || !dir || !agents[agent]) {
    return reply(ctx, `Usage: /new <agent> [dir] (default: ${process.env.BRIDGE_DEFAULT_DIR ?? "none set"})\nAgents: ${Object.keys(agents).join(", ")}`);
  }
  sessions.set(key(ctx), { agent, dir, busy: false });
  saveSessions(sessions);
  await reply(ctx, `Session ready: ${agent} @ ${dir}\nJust send messages now.`);
});

bot.command("ls", async (ctx) => {
  const lines = [...sessions.entries()].map(([k, s]) => `${k} → ${s.agent} @ ${s.dir}${s.busy ? " (busy)" : ""}`);
  await reply(ctx, lines.join("\n") || "No sessions. /new <agent> <dir>");
});

bot.command("end", async (ctx) => {
  sessions.delete(key(ctx));
  saveSessions(sessions);
  await reply(ctx, "Session ended.");
});

bot.command("fresh", async (ctx) => {
  const s = sessions.get(key(ctx));
  if (s) { s.resumeId = undefined; saveSessions(sessions); }
  await reply(ctx, s ? "Conversation reset (same agent/dir)." : "No session here.");
});

bot.command("model", async (ctx) => {
  const s = sessions.get(key(ctx));
  if (!s) return reply(ctx, "No session here. /new <agent> <dir> first.");
  const arg = ctx.match?.trim();
  if (!arg) return reply(ctx, `Current model: ${s.model ?? "default (account)"}
Usage: /model opus | sonnet | haiku | <full-id>`);
  s.model = arg;                 // claude accepts aliases (opus/sonnet/haiku) and full ids
  saveSessions(sessions);
  await reply(ctx, `Model set to ${arg} (applies to the next message).`);
});

bot.command("start", (ctx) =>
  reply(ctx, "CLI-agent bridge.\n/new <agent> <dir> — spawn a session\n/ls — list\n/model <name> — pick model\n/fresh — reset conversation\n/end - remove session\nSend a photo/file to drop it in the agent's cwd; screenshots it makes come back here."),
);

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

bot.catch((e) => console.error("bot error:", e.error));
// any escaped failure -> exit nonzero so the autostart loop relaunches us clean
process.on("unhandledRejection", (e) => { console.error("fatal:", e); process.exit(1); });
process.on("uncaughtException", (e) => { console.error("fatal:", e); process.exit(1); });
console.error("bridge up — long polling");
// Reconcile Telegram's /command menu with the handlers that actually exist above.
// setMyCommands REPLACES the whole list, so this also purges stale commands (e.g. /status)
// that were showing "not available". Keep this array in lockstep with bot.command(...).
const MENU = [
  { command: "new", description: "spawn a session: /new <agent> [dir]" },
  { command: "ls", description: "list active sessions" },
  { command: "model", description: "pick claude model: opus|sonnet|haiku" },
  { command: "fresh", description: "reset the conversation (keep agent+dir)" },
  { command: "end", description: "kill this session" },
  { command: "start", description: "show help" },
];

bot.start({
  onStart: async (me) => {
    console.error("polling as", me.username);
    try { await bot.api.setMyCommands(MENU); } catch (e) { console.error("setMyCommands failed:", e); }
  },
});

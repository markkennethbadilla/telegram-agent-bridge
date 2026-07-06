// Telegram <-> CLI-agent bridge. One session per chat/topic; spawn agents from nothing.
// Long polling only: no ports, no webhooks, no exposure.
import { Bot } from "grammy";
import { agents, type Session } from "./agents";
import { loadSessions, saveSessions } from "./store";

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
  reply(ctx, "CLI-agent bridge.\n/new <agent> <dir> — spawn a session\n/ls — list\n/model <name> — pick model\n/fresh — reset conversation\n/end — remove session"),
);

bot.on("message:text", async (ctx) => {
  const s = sessions.get(key(ctx));
  if (!s) return reply(ctx, "No session in this chat/topic. /new <agent> <dir>");
  if (s.busy) return reply(ctx, "Still working on the previous message — hold on.");
  s.busy = true;
  const typing = setInterval(() => ctx.replyWithChatAction("typing").catch(() => {}), 5000);
  ctx.replyWithChatAction("typing").catch(() => {});
  try {
    const r = await agents[s.agent](ctx.message.text, s);
    s.resumeId = r.resumeId ?? s.resumeId;
    saveSessions(sessions);
    await reply(ctx, r.text.trim() || "(empty response)");
  } catch (e: any) {
    await reply(ctx, `Error: ${e.message}`);
  } finally {
    clearInterval(typing);
    s.busy = false;
  }
});

bot.catch((e) => console.error("bot error:", e.error));
// any escaped failure -> exit nonzero so the autostart loop relaunches us clean
process.on("unhandledRejection", (e) => { console.error("fatal:", e); process.exit(1); });
process.on("uncaughtException", (e) => { console.error("fatal:", e); process.exit(1); });
console.error("bridge up — long polling");
bot.start({ onStart: (me) => console.error("polling as", me.username) });

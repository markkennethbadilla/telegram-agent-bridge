// Agent adapters: each turns (message, session) into a headless CLI run.
// Adding an agent = one entry here. No SDKs, no TUI scraping.
import { spawn } from "bun";
import { existsSync } from "node:fs";

export interface Session {
  agent: string;
  dir: string;
  resumeId?: string; // agent-native session/conversation id, if any
  model?: string;    // /model override; passed to claude --model (alias ok)
  busy: boolean;
}

export interface RunResult {
  text: string;
  resumeId?: string;
}

// Windows: CLI agents install as .cmd/.exe shims that bare names don't resolve to
function exe(name: string): string {
  const home = process.env.USERPROFILE ?? "";
  const known = [`${home}/.local/bin/${name}.exe`, `${home}/.bun/bin/${name}.exe`];
  return (
    Bun.which(name) ?? Bun.which(`${name}.cmd`) ?? Bun.which(`${name}.exe`) ??
    known.find((p) => existsSync(p)) ?? name
  );
}

const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS ?? 10 * 60 * 1000);

async function run(cmd: string[], dir: string): Promise<string> {
  const proc = spawn({ cmd: [exe(cmd[0]), ...cmd.slice(1)], cwd: dir, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), TURN_TIMEOUT_MS); // a hung agent must not wedge the session
  proc.exited.finally(() => clearTimeout(timer));
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0 && !out.trim()) throw new Error(`${cmd[0]} exited ${code}: ${err.slice(0, 1500)}`);
  return out;
}

export const agents: Record<string, (msg: string, s: Session) => Promise<RunResult>> = {
  async claude(msg, s) {
    const cmd = ["claude", "-p", "--output-format", "json", "--dangerously-skip-permissions"];
    if (s.model) cmd.push("--model", s.model);
    if (s.resumeId) cmd.push("--resume", s.resumeId);
    cmd.push(msg);
    const out = await run(cmd, s.dir);
    // claude may emit one JSON object or a stream of JSON lines; the result object wins
    let best: any = null;
    for (const line of out.split(/\r?\n/)) {
      try {
        const j = JSON.parse(line);
        if (j && typeof j === "object") best = j.type === "result" || j.result !== undefined ? j : best ?? j;
      } catch {}
    }
    if (!best) try { best = JSON.parse(out); } catch {}
    if (Array.isArray(best)) best = best.find((e: any) => e?.type === "result") ?? best[best.length - 1];
    if (!best) return { text: out, resumeId: s.resumeId };
    return { text: best.result ?? best.text ?? JSON.stringify(best).slice(0, 3000), resumeId: best.session_id ?? s.resumeId };
  },

  async opencode(msg, s) {
    // ponytail: opencode keeps its own per-dir continuity via --continue; no id parsing needed
    const cmd = ["opencode", "run", ...(s.resumeId ? ["--continue"] : []), msg];
    const out = await run(cmd, s.dir);
    return { text: out || "(no output)", resumeId: "continue" };
  },

  async hermes(msg, s) {
    // ponytail: -z is one-shot; per-topic continuity needs hermes session naming, add if used often
    const out = await run(["hermes", "-z", msg, "--dev"], s.dir); // --dev = plain stdout; default renderer prints nothing when piped
    return { text: out || "(no output)" };
  },

  async codex(msg, s) {
    // codex exec = non-interactive mode (developers.openai.com/codex/noninteractive,
    // verified 2026-07-06); resume via `codex exec resume --last` — same
    // most-recent-conversation semantics (and same raciness caveat) as agy.
    // --skip-git-repo-check: sessions may start in non-repo dirs.
    const cmd = s.resumeId
      ? ["codex", "exec", "resume", "--last", "--skip-git-repo-check", msg]
      : ["codex", "exec", "--skip-git-repo-check", msg];
    const out = await run(cmd, s.dir);
    return { text: out || "(no output)", resumeId: "last" };
  },

  async agy(msg, s) {
    // --continue resumes the most recent conversation: fine for one agy topic, racy for several
    const cmd = ["agy", "--print", msg, "--dangerously-skip-permissions", ...(s.resumeId ? ["--continue"] : [])];
    const out = await run(cmd, s.dir);
    return { text: out || "(no output)", resumeId: "continue" };
  },

  async shell(msg, s) {
    const out = await run(["pwsh", "-NoProfile", "-NonInteractive", "-Command", msg], s.dir);
    return { text: out || "(no output)" };
  },
};

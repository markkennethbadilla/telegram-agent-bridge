// Agent adapters: each turns (message, session) into a headless CLI run.
// Adding an agent = one entry here. No SDKs, no TUI scraping.
import { spawn } from "bun";
import { existsSync } from "node:fs";

export interface Session {
  agent: string;
  dir: string;
  resumeId?: string; // agent-native session/conversation id, if any
  busy: boolean;
}

export interface RunResult {
  text: string;
  resumeId?: string;
}

// Windows: CLI agents install as .cmd/.exe shims that bare names don't resolve to
function exe(name: string): string {
  const home = process.env.USERPROFILE ?? "";
  const known = [`${home}\.local\bin\${name}.exe`, `${home}\.bun\bin\${name}.exe`];
  return (
    Bun.which(name) ?? Bun.which(`${name}.cmd`) ?? Bun.which(`${name}.exe`) ??
    known.find((p) => existsSync(p)) ?? name
  );
}

async function run(cmd: string[], dir: string): Promise<string> {
  const proc = spawn({ cmd: [exe(cmd[0]), ...cmd.slice(1)], cwd: dir, stdout: "pipe", stderr: "pipe" });
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
    if (s.resumeId) cmd.push("--resume", s.resumeId);
    cmd.push(msg);
    const out = await run(cmd, s.dir);
    try {
      const j = JSON.parse(out);
      return { text: j.result ?? out, resumeId: j.session_id ?? s.resumeId };
    } catch {
      return { text: out, resumeId: s.resumeId };
    }
  },

  async opencode(msg, s) {
    // ponytail: opencode keeps its own per-dir continuity via --continue; no id parsing needed
    const cmd = ["opencode", "run", ...(s.resumeId ? ["--continue"] : []), msg];
    const out = await run(cmd, s.dir);
    return { text: out || "(no output)", resumeId: "continue" };
  },

  async shell(msg, s) {
    const out = await run(["pwsh", "-NoProfile", "-NonInteractive", "-Command", msg], s.dir);
    return { text: out || "(no output)" };
  },
};

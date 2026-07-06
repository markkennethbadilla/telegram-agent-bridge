// Session persistence so a bridge restart keeps conversations resumable.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "./agents";

const dir = join(process.env.LOCALAPPDATA ?? ".", "telegram-agent-bridge");
const file = join(dir, "sessions.json");

export function loadSessions(): Map<string, Session> {
  try {
    if (existsSync(file)) {
      const obj = JSON.parse(readFileSync(file, "utf8"));
      return new Map(Object.entries(obj).map(([k, s]: [string, any]) => [k, { ...s, busy: false }]));
    }
  } catch {} // corrupt state file -> start clean, sessions are re-creatable
  return new Map();
}

export function saveSessions(m: Map<string, Session>) {
  mkdirSync(dir, { recursive: true });
  // strip runtime-only fields (proc = a live child process; busy = transient) before persisting
  const plain = Object.fromEntries(
    [...m].map(([k, { proc, busy, ...rest }]) => [k, rest]),
  );
  writeFileSync(file, JSON.stringify(plain, null, 2));
}

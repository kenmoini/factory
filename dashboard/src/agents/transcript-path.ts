import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function cwdSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

const SAFE = /^[A-Za-z0-9_-]+$/;

export function resolveTranscriptPath(opts: { homeDir: string; cwd: string; agentId: string; sessionId?: string }): string | null {
  const { homeDir, cwd, agentId, sessionId } = opts;
  if (!homeDir || !SAFE.test(agentId)) return null;
  const base = join(homeDir, ".claude", "projects", cwdSlug(cwd));
  const file = `agent-${agentId}.jsonl`;
  if (sessionId && SAFE.test(sessionId)) {
    const direct = join(base, sessionId, "subagents", file);
    if (existsSync(direct)) return direct;
  }
  try {
    for (const d of readdirSync(base, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const p = join(base, d.name, "subagents", file);
      if (existsSync(p)) return p;
    }
  } catch { /* no such project dir */ }
  return null;
}

export function readMeta(path: string): { agentType?: string; description?: string; model?: string; finished?: boolean } | null {
  try {
    const v = JSON.parse(readFileSync(path.replace(/\.jsonl$/, ".meta.json"), "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

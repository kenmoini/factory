import { resolve, sep, join } from "node:path";
import { readMeta, resolveTranscriptPath, cwdSlug } from "../agents/transcript-path";
import type { AgentRegistry } from "../agents/registry";
import { TranscriptTailer } from "../agents/tailer";
import type { EventHub } from "../hub";
import type { RepoEntry, RepoRegistry } from "../repos";
import type { HookEvent, LiveAgent } from "../shared/types";

export interface EventDeps {
  repos: RepoRegistry;
  registry: AgentRegistry;
  hub: EventHub;
  tailers: Map<string, TranscriptTailer>;
  homeDir: string;
  addRepo: (p: string) => RepoEntry | null;
  refresh: (repoKey: string) => void;
  lastTask?: Map<string, HookEvent>;
}

const ok = () => new Response(null, { status: 204 });
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const SAFE = /^[A-Za-z0-9_-]+$/;

export function handleEvent(body: unknown, deps: EventDeps): Response {
  if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "object body required" }, { status: 400 });
  const b = body as Partial<HookEvent>;
  if (typeof b.event !== "string" || typeof b.project !== "string" || !b.event || !b.project) {
    return Response.json({ error: "event and project required" }, { status: 400 });
  }
  const repoKey = resolve(b.project);
  if (!deps.repos.get(repoKey) && !deps.addRepo(repoKey)) return ok();
  const payload = (b.payload && typeof b.payload === "object" ? b.payload : {}) as Record<string, unknown>;

  switch (b.event) {
    case "subagent-start": return onStart(repoKey, payload, deps);
    case "subagent-stop": return onStop(repoKey, payload, deps);
    case "stage": case "task": case "agent": case "session-start":
      if ((b.event === "task" || b.event === "agent") && b.task) deps.lastTask?.set(repoKey, b as HookEvent);
      deps.refresh(repoKey);
      return ok();
    default: return ok();
  }
}

function onStart(repoKey: string, p: Record<string, unknown>, deps: EventDeps): Response {
  const agentId = str(p.agent_id);
  if (!agentId || !SAFE.test(agentId)) return ok();
  const cwd = str(p.cwd) ?? repoKey;
  const sessionId = str(p.session_id);
  deps.tailers.get(agentId)?.stop();
  deps.tailers.delete(agentId);

  let path = resolveTranscriptPath({ homeDir: deps.homeDir, cwd, agentId, sessionId });
  if (!path && sessionId && SAFE.test(sessionId) && deps.homeDir) {
    path = join(deps.homeDir, ".claude", "projects", cwdSlug(cwd), sessionId, "subagents", `agent-${agentId}.jsonl`);
  }
  const meta = path ? readMeta(path) : null;
  const agent = deps.registry.start({
    agentId, agentType: str(p.agent_type) ?? meta?.agentType ?? "unknown", cwd, sessionId,
    description: str(p.description) ?? meta?.description, model: str(p.model) ?? meta?.model,
    transcriptPath: path ?? undefined,
  });
  if (path) {
    const tailer = new TranscriptTailer(path, (step) => {
      const cur = deps.registry.get(agentId);
      if (!cur) return;
      const patch: Partial<LiveAgent> = { stepCount: cur.stepCount + 1 };
      if (!cur.taskNoteId || !cur.description) {
        const m = readMeta(path!);
        if (m?.description) {
          patch.description = m.description;
          const t = m.description.match(/\[task:([^\]]+)\]/);
          if (t) patch.taskNoteId = t[1];
        }
        if (m?.model && !cur.model) patch.model = m.model;
      }
      deps.registry.touch(agentId, patch);
      deps.hub.publish(repoKey, { type: "step", data: { agentId, step } });
    });
    deps.tailers.set(agentId, tailer);
    tailer.start();
  }
  deps.hub.publish(repoKey, { type: "agent", data: { op: "start", agent: { ...agent } } });
  return ok();
}

function onStop(repoKey: string, p: Record<string, unknown>, deps: EventDeps): Response {
  const agentId = str(p.agent_id);
  if (!agentId) return ok();
  let tailer = deps.tailers.get(agentId);
  const given = str(p.agent_transcript_path);
  const root = deps.homeDir ? join(deps.homeDir, ".claude", "projects") + sep : null;
  if (!tailer && given && root && resolve(given).startsWith(root)) {
    tailer = new TranscriptTailer(resolve(given), (step) => {
      const cur = deps.registry.get(agentId);
      if (cur) deps.registry.touch(agentId, { stepCount: cur.stepCount + 1 });
      deps.hub.publish(repoKey, { type: "step", data: { agentId, step } });
    });
    deps.tailers.set(agentId, tailer);
    tailer.start();
  }
  tailer?.readMore();
  tailer?.stop();
  const tp = given && root && resolve(given).startsWith(root) ? resolve(given) : undefined;
  const agent = deps.registry.stop(agentId, { transcriptPath: tp });
  if (agent) deps.hub.publish(repoKey, { type: "agent", data: { op: "stop", agent: { ...agent } } });
  return ok();
}

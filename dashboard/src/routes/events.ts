import { resolve, sep, join } from "node:path";
import { readMeta, resolveTranscriptPath } from "../agents/transcript-path";
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
const TASK_TAG = /\[task:([^\]]+)\]/;

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

  const resolvePath = () => resolveTranscriptPath({ homeDir: deps.homeDir, cwd, agentId, sessionId });
  const path = resolvePath();
  const meta = path ? readMeta(path) : null;
  const agent = deps.registry.start({
    agentId, agentType: str(p.agent_type) ?? meta?.agentType ?? "unknown", cwd, sessionId,
    description: str(p.description) ?? meta?.description, model: str(p.model) ?? meta?.model,
    transcriptPath: path ?? undefined,
  });
  // publish start before the tailer's first synchronous read can publish steps
  deps.hub.publish(repoKey, { type: "agent", data: { op: "start", agent: { ...agent } } });
  if (deps.homeDir) {
    // re-run the lookup on each retry tick so a late-appearing transcript is still found
    let metaReread = false;
    const tailer: TranscriptTailer = new TranscriptTailer(resolvePath, (step) => {
      const cur = deps.registry.get(agentId);
      if (!cur) return;
      const patch: Partial<LiveAgent> = { stepCount: cur.stepCount + 1 };
      if (!cur.transcriptPath && tailer.path) patch.transcriptPath = tailer.path;
      if (!metaReread && tailer.path) {
        metaReread = true; // once, the first time the file is seen
        const m = readMeta(tailer.path);
        if (m?.description && !cur.description) patch.description = m.description;
        // the hook's description may lack the tag that the prompt (and so the meta file) carries
        const t = (patch.description ?? cur.description)?.match(TASK_TAG) ?? m?.description?.match(TASK_TAG);
        if (t && !cur.taskNoteId) patch.taskNoteId = t[1];
        if (m?.model && !cur.model) patch.model = m.model;
      }
      const updated = deps.registry.touch(agentId, patch);
      // stepCount alone rides on the step events; a back-filled task, model or description changes the card line
      if (updated && (patch.description || patch.taskNoteId || patch.model)) {
        deps.hub.publish(repoKey, { type: "agent", data: { op: "update", agent: { ...updated } } });
      }
      deps.hub.publish(repoKey, { type: "step", data: { agentId, step } });
    });
    deps.tailers.set(agentId, tailer);
    tailer.start();
  }
  return ok();
}

function onStop(repoKey: string, p: Record<string, unknown>, deps: EventDeps): Response {
  const agentId = str(p.agent_id);
  if (!agentId || !deps.registry.get(agentId)) return ok();
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

import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { readMeta, resolveTranscriptPath } from "../agents/transcript-path";
import type { AgentRegistry } from "../agents/registry";
import { TranscriptTailer } from "../agents/tailer";
import type { EventHub } from "../hub";
import type { RepoEntry, RepoRegistry } from "../repos";
import type { SessionTracker } from "../sessions";
import { taskNoteIdOf } from "../shared/agents";
import type { HookEvent, LiveAgent } from "../shared/types";

export interface EventDeps {
  repos: RepoRegistry;
  registry: AgentRegistry;
  hub: EventHub;
  tailers: Map<string, TranscriptTailer>;
  homeDir: string;
  addRepo: (p: string) => RepoEntry | null;
  refresh: (repoKey: string) => void;
  /** Re-reads the repo's git state soon: a task, stage or agent event may have committed. */
  refreshGit?: (repoKey: string) => void;
  lastTask?: Map<string, HookEvent>;
  /** Re-reads a registered repo's `.factory/config.json` (and follows a changed `activeWorkstream`). */
  syncRepo?: (repoKey: string) => void;
  /** Points the repo's poller at the envelope's `workstream`, unless the user picked one. */
  followWorkstream?: (repoKey: string, slug: string) => void;
  /** Learns the sessions that post events, and that every event is activity (see sessions.ts). */
  sessions?: SessionTracker;
  now?: () => number;
}

const ok = () => new Response(null, { status: 204 });
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const SAFE = /^[A-Za-z0-9_-]+$/;
/** `v` as a process id: a positive integer, else undefined. */
export const pidOf = (v: unknown): number | undefined => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : undefined);

/** `path` resolved, if it lies under `~/.claude/projects` (where Claude Code keeps transcripts); otherwise undefined. */
function underProjects(homeDir: string, path: string | undefined): string | undefined {
  if (!homeDir || !path) return undefined;
  const abs = resolve(path);
  return abs.startsWith(join(homeDir, ".claude", "projects") + sep) ? abs : undefined;
}

export function handleEvent(body: unknown, deps: EventDeps): Response {
  if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "object body required" }, { status: 400 });
  const b = body as Partial<HookEvent>;
  if (typeof b.event !== "string" || typeof b.project !== "string" || !b.event || !b.project) {
    return Response.json({ error: "event and project required" }, { status: 400 });
  }
  const repoKey = resolve(b.project);
  if (deps.repos.get(repoKey)) deps.syncRepo?.(repoKey);
  else if (!deps.addRepo(repoKey)) return ok();
  const ws = str(b.workstream);
  if (ws) deps.followWorkstream?.(repoKey, ws);
  const payload = (b.payload && typeof b.payload === "object" ? b.payload : {}) as Record<string, unknown>;
  const sessionId = str(payload.session_id) ?? str(b.session);
  if (sessionId) {
    deps.sessions?.seen(sessionId, repoKey, { transcriptPath: underProjects(deps.homeDir, str(payload.transcript_path)), pid: pidOf(b.pid) });
  }
  deps.sessions?.activity();

  switch (b.event) {
    case "subagent-start": return onStart(repoKey, payload, deps);
    case "subagent-stop": return onStop(repoKey, payload, deps);
    case "session-start":
      endOtherSessions(repoKey, payload, deps);
      deps.refresh(repoKey);
      return ok();
    case "session-end":
      if (sessionId) {
        // the session's subagents will never send their stop
        for (const a of deps.registry.list(repoKey).live) if (a.sessionId === sessionId) stopAgent(a.agentId, deps);
        deps.sessions?.end(sessionId);
      }
      deps.refresh(repoKey);
      return ok();
    case "stage": case "task": case "agent":
      if ((b.event === "task" || b.event === "agent") && b.task) deps.lastTask?.set(repoKey, b as HookEvent);
      deps.refresh(repoKey);
      deps.refreshGit?.(repoKey);
      return ok();
    default: return ok();
  }
}

/** Reads what is left of the agent's transcript, stops its tailer and the agent, and publishes `agent stop`. */
export function stopAgent(agentId: string, deps: Pick<EventDeps, "registry" | "hub" | "tailers">, patch: { transcriptPath?: string } = {}): LiveAgent | undefined {
  const tailer = deps.tailers.get(agentId);
  tailer?.readMore();
  tailer?.stop();
  const agent = deps.registry.stop(agentId, patch);
  if (agent?.repoKey) deps.hub.publish(agent.repoKey, { type: "agent", data: { op: "stop", agent: { ...agent } } });
  return agent;
}

/**
 * A new Claude Code session in the repo (`source: "startup"`, or no source and a `session_id`) means the previous
 * session's subagents will never send their stop: mark the repo's live agents of other sessions stopped.
 * `clear` and `compact` keep the session's agents.
 */
function endOtherSessions(repoKey: string, p: Record<string, unknown>, deps: EventDeps): void {
  const source = str(p.source), sessionId = str(p.session_id);
  if (!(source === "startup" || (source === undefined && sessionId))) return;
  for (const a of deps.registry.list(repoKey).live) if (a.sessionId !== sessionId) stopAgent(a.agentId, deps);
}

/** A tailer whose steps bump the agent's step count and are published; the first time the file is seen its meta back-fills description, task and model. */
function makeTailer(agentId: string, repoKey: string, source: string | (() => string | null), deps: EventDeps): TranscriptTailer {
  let metaReread = false;
  const tailer: TranscriptTailer = new TranscriptTailer(source, (step) => {
    const cur = deps.registry.get(agentId);
    if (!cur) return;
    const patch: Partial<LiveAgent> = { stepCount: cur.stepCount + 1 };
    if (tailer.path && cur.transcriptPath !== tailer.path) patch.transcriptPath = tailer.path;
    if (!metaReread && tailer.path) {
      metaReread = true; // once, the first time the file is seen
      const m = readMeta(tailer.path);
      if (m?.description && !cur.description) patch.description = m.description;
      // the hook's description may lack the tag that the prompt (and so the meta file) carries
      const task = taskNoteIdOf(patch.description ?? cur.description) ?? taskNoteIdOf(m?.description);
      if (task && !cur.taskNoteId) patch.taskNoteId = task;
      if (m?.model && !cur.model) patch.model = m.model;
    }
    const updated = deps.registry.touch(agentId, patch);
    // stepCount alone rides on the step events; a back-filled task, model or description changes the card line
    if (updated && (patch.description || patch.taskNoteId || patch.model)) {
      deps.hub.publish(repoKey, { type: "agent", data: { op: "update", agent: { ...updated } } });
    }
    deps.hub.publish(repoKey, { type: "step", data: { agentId, step } });
  }, { now: deps.now });
  return tailer;
}

function onStart(repoKey: string, p: Record<string, unknown>, deps: EventDeps): Response {
  const agentId = str(p.agent_id);
  if (!agentId || !SAFE.test(agentId)) return ok();
  const cwd = str(p.cwd) ?? repoKey;
  const sessionId = str(p.session_id);
  deps.tailers.get(agentId)?.stop();
  deps.tailers.delete(agentId);

  // 1. next to the session transcript Claude Code names: <projects>/<slug>/<session>.jsonl → <projects>/<slug>/<session>/subagents/
  // 2. under the project's slug; 3. under the cwd's slug (a subagent's cwd may be a worktree). Re-run on each retry tick.
  const session = underProjects(deps.homeDir, str(p.transcript_path));
  const fromSession = session && sessionId && SAFE.test(sessionId) ? join(dirname(session), sessionId, "subagents", `agent-${agentId}.jsonl`) : undefined;
  const resolvePath = (): string | null => {
    if (fromSession && existsSync(fromSession)) return fromSession;
    return resolveTranscriptPath({ homeDir: deps.homeDir, cwd: repoKey, agentId, sessionId })
      ?? (cwd !== repoKey ? resolveTranscriptPath({ homeDir: deps.homeDir, cwd, agentId, sessionId }) : null);
  };
  const path = resolvePath();
  const meta = path ? readMeta(path) : null;
  const agent = deps.registry.start({
    agentId, agentType: str(p.agent_type) ?? meta?.agentType ?? "unknown", cwd, repoKey, sessionId,
    description: str(p.description) ?? meta?.description, model: str(p.model) ?? meta?.model,
    transcriptPath: path ?? undefined,
  });
  // publish start before the tailer's first synchronous read can publish steps
  deps.hub.publish(repoKey, { type: "agent", data: { op: "start", agent: { ...agent } } });
  if (deps.homeDir) {
    const tailer = makeTailer(agentId, repoKey, resolvePath, deps);
    deps.tailers.set(agentId, tailer);
    tailer.start();
  }
  return ok();
}

function onStop(repoKey: string, p: Record<string, unknown>, deps: EventDeps): Response {
  const agentId = str(p.agent_id);
  if (!agentId || !deps.registry.get(agentId)) return ok();
  const given = underProjects(deps.homeDir, str(p.agent_transcript_path));
  const old = deps.tailers.get(agentId);
  // Claude Code names the transcript at stop: when the start lookup missed it or found another file, tail that one instead
  if (given && (!old || !old.found || old.path !== given)) {
    old?.stop();
    deps.registry.touch(agentId, { stepCount: 0 }); // the replacement counts from its own first step
    const tailer = makeTailer(agentId, repoKey, given, deps);
    deps.tailers.set(agentId, tailer);
    tailer.start(); // reads the whole file synchronously when it exists
  }
  stopAgent(agentId, deps, { transcriptPath: given });
  return ok();
}

# Factory Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the local web dashboard that shows a factory project's Trilium documents in tabs and its milestones/tasks/agents as a live Kanban board, with a detached daemon the orchestrator starts.

**Architecture:** A single Bun process: `Bun.serve` with HTML imports bundles a React/TSX front end on the fly; a per-repo poller reads Trilium over ETAPI (read-only) and publishes snapshots on change; hook events arrive on `POST /api/events`; subagent steps are tailed from Claude Code transcript JSONL files; everything reaches the browser over one SSE stream. `bin/factory-dashboard` (shim from the plugin plan) launches `src/daemon.ts`, which detaches the server with a pidfile.

**Tech Stack:** Bun ≥ 1.2.10, TypeScript, React 19, `marked`, `dompurify` (+ `jsdom`-free: sanitize in the browser), `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-10-factory-plugin-design.md` (section "Dashboard")

## Global Constraints

- Dashboard is read-only toward Trilium; it never calls `create`/`set`/`delete` ETAPI endpoints.
- The ETAPI token never reaches the browser: all note content is proxied through `/api/docs/:id`; no endpoint echoes config.
- Config from `~/.config/claude-factory/config.json` (`FACTORY_CONFIG_DIR` override), keys `triliumUrl`, `etapiToken`, `dashboardPort` (default 7777); env overrides `FACTORY_TRILIUM_URL`, `FACTORY_ETAPI_TOKEN`, `FACTORY_DASHBOARD_PORT`, `FACTORY_POLL_MS` (default 3000).
- Server binds `127.0.0.1` only.
- Status vocabulary and column mapping exactly as the spec: todo→backlog, spec→spec-writer, building|fixing→builder, reviewing→reviewers, approving|merging→approver, needs-human|blocked→needs-human, done→done.
- Label names exactly as the spec's Trilium schema (`factoryProject`, `repoPath`, `factoryWorkstream`, `slug`, `wsStatus`, `factoryMilestone`, `milestoneId`, `order`, `status`, `factoryTask`, `taskId`, `round`, `agentId`, `builderAgentId`, `escalation`, `dependsOn`, `factoryDoc`, `factoryReview`, `reviewer`, `verdict`, `factoryAgentRun`, `agentType`, `startedAt`, `endedAt`).
- Transcript lines of `type` other than `assistant`/`user` are ignored; `thinking` blocks produce a `kind:"thinking"` step with no text (count only).
- Event ingest body is the plugin's shape `{event, ts, project, stage?, status?, task?, workstream?, payload}`; `payload` holds the raw hook JSON (`agent_id`, `agent_type`, `session_id`, `cwd`, `agent_transcript_path`, …).
- All tests run with `bun test dashboard/`; integration tests bind port 0 and never touch the network or the real `~/.claude`.
- Same-origin only: no CORS headers.

## Review Focus

1. Trilium returns a note whose labels are missing or malformed (no `#status`, non-numeric `#order`/`#round`): the mapper must default (`status:"todo"`, `order:0`, `round:0`) instead of throwing and blanking the board — test in Task 2.
2. A transcript line that is truncated mid-write or is not JSON: the parser must skip it and the tailer must keep its partial-line buffer so the completed line is parsed on the next read — tests in Tasks 3 and 6.
3. `POST /api/events` with an unknown `project` path or a body missing `payload`: respond 400 or 204 without crashing, and never register a repo that has no `.factory/config.json` — test in Task 6.
4. A `/mockups/<slug>/../../etc/passwd` request: must return 404, never a file outside the mockups directory — test in Task 9.
5. Trilium becomes unreachable mid-run: the poller must keep the last snapshot, mark `trilium.ok=false` in `/api/health`, and resume automatically when the next poll succeeds (no process exit) — test in Task 4.

---

### Task 0: Static mockup for the user's reaction

**Files:**
- Create: `dashboard/mockup/board.html` (self-contained HTML+CSS, fake data: 3 milestones, 8 tasks across all columns, one running agent with 5 steps in an open drawer, tab bar with Board/Goal/Standards/Spec/Plan/Agents)
- No tests.

- [ ] **Step 1: Write the mockup** (one file, no JS beyond tab switching; dark-neutral palette; card = title, milestone chip, agent+model, round, elapsed, four reviewer chips in the Reviewers column).
- [ ] **Step 2: `open dashboard/mockup/board.html`; report to the user and collect feedback before Task 8 starts. Tasks 1–7 do not depend on it.**
- [ ] **Step 3: Commit** — `git commit -m "design(dashboard): static board mockup"`

---

### Task 1: Dashboard scaffold, shared types, column rules

**Files:**
- Create: `dashboard/package.json`, `dashboard/tsconfig.json`, `dashboard/src/shared/types.ts`, `dashboard/src/shared/columns.ts`
- Test: `dashboard/test/columns.test.ts`

**Interfaces:**
- `package.json`: `{"name":"factory-dashboard","private":true,"type":"module","scripts":{"start":"bun src/server.ts","dev":"FACTORY_DEV=1 bun --watch src/server.ts","test":"bun test"},"dependencies":{"react":"^19","react-dom":"^19","marked":"^15","dompurify":"^3"},"devDependencies":{"@types/bun":"latest","@types/react":"^19","@types/react-dom":"^19"},"engines":{"bun":">=1.2.10"}}`; `tsconfig.json`: `jsx: "react-jsx"`, `strict`, `types: ["@types/bun"]`, `moduleResolution: "bundler"`, `noEmit`.
- `types.ts` (exact names used by every later task):
  ```ts
  export type TaskStatus = "todo"|"spec"|"building"|"reviewing"|"fixing"|"approving"|"merging"|"done"|"needs-human"|"blocked";
  export type Column = "backlog"|"spec-writer"|"builder"|"reviewers"|"approver"|"needs-human"|"done";
  export type Reviewer = "security"|"ux"|"ui-design"|"code";
  export type Labels = Record<string, string>;
  export interface Project { id: string; title: string; repo: string; repoPath: string; labels: Labels; modified: string }
  export interface Workstream { id: string; slug: string; title: string; status: string; labels: Labels; modified: string }
  export interface Milestone { id: string; milestoneId: string; title: string; order: number; status: string; modified: string }
  export interface Task { id: string; taskId: string; title: string; status: TaskStatus; milestoneId: string; order: number; round: number; agentId?: string; builderAgentId?: string; escalation?: string; dependsOn: string[]; modified: string }
  export interface Doc { id: string; kind: string; title: string; format: "html"|"markdown"; parentId?: string; modified: string }
  export interface Review { id: string; taskId: string; round: number; reviewer: Reviewer; verdict: "PASS"|"CHANGES"|"PENDING"; modified: string }
  export interface AgentRun { id: string; title: string; agentType: string; agentId?: string; status: "running"|"done"|"failed"; taskId?: string; startedAt?: string; endedAt?: string }
  export interface LiveAgent { agentId: string; agentType: string; description?: string; model?: string; taskNoteId?: string; cwd: string; sessionId?: string; startedAt: string; finishedAt?: string; transcriptPath?: string; stepCount: number }
  export interface Step { seq: number; ts: string; kind: "text"|"thinking"|"tool"|"result"; text?: string; tool?: { name: string; summary: string }; toolUseId?: string; isError?: boolean }
  export interface WorkstreamSnapshot { project: Project; workstream: Workstream|null; milestones: Milestone[]; tasks: Task[]; docs: Doc[]; reviews: Review[]; runs: AgentRun[]; live: LiveAgent[]; fingerprint: string }
  export interface HookEvent { event: string; ts: string; project: string; stage?: string; status?: string; task?: string; workstream?: string; payload: Record<string, unknown> }
  export type StreamEvent = { type:"snapshot"; data: WorkstreamSnapshot } | { type:"agent"; data:{ op:"start"|"update"|"stop"; agent: LiveAgent } } | { type:"step"; data:{ agentId: string; step: Step } } | { type:"heartbeat"; data:{ ts: string } };
  ```
- `columns.ts`: `export const COLUMN_ORDER: Column[]`, `export const COLUMN_TITLES: Record<Column,string>` (`Backlog, Spec Writer, Builder, Reviewers, Approver, Needs Human, Done`), `export function columnFor(task: Pick<Task,"status">): Column`, `export function sortTasks(tasks: Task[], milestones: Milestone[]): Task[]` (milestone order then task order then taskId).

- [ ] **Step 1: Write the failing test** — table-driven over all 10 statuses → expected column; unknown status → `backlog`; `sortTasks` orders by milestone then task order.
- [ ] **Step 2: Run `bun test dashboard/test/columns.test.ts`** → FAIL. **Step 3: Create scaffold + `bun install` in `dashboard/` + implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(dashboard): scaffold, shared types, column rules"`

---

### Task 2: Trilium ETAPI client and mapper

**Files:**
- Create: `dashboard/src/trilium/client.ts`, `dashboard/src/trilium/mapper.ts`, `dashboard/test/fixtures/etapi/{project,workstreams,milestones,tasks,docs,reviews,runs}.json`
- Test: `dashboard/test/mapper.test.ts`, `dashboard/test/client.test.ts`

**Interfaces:**
- `client.ts`:
  ```ts
  export interface EtapiAttribute { attributeId: string; noteId: string; type: "label"|"relation"; name: string; value: string; position: number; isInheritable: boolean }
  export interface EtapiNote { noteId: string; title: string; type: string; mime: string; attributes: EtapiAttribute[]; parentNoteIds: string[]; childNoteIds: string[]; dateCreated: string; dateModified: string; utcDateCreated: string; utcDateModified: string }
  export interface SearchOpts { ancestorNoteId?: string; ancestorDepth?: string; orderBy?: string; orderDirection?: "asc"|"desc"; limit?: number; fastSearch?: boolean }
  export class TriliumError extends Error { constructor(message: string, public status?: number) }
  export class TriliumClient {
    constructor(opts: { baseUrl: string; token: string; fetchImpl?: typeof fetch; timeoutMs?: number });
    search(query: string, opts?: SearchOpts): Promise<EtapiNote[]>;   // GET /etapi/notes?search=…&… ; header Authorization: <token>
    getNote(id: string): Promise<EtapiNote>;
    getContent(id: string): Promise<{ content: string; mime: string }>;
    appInfo(): Promise<{ appVersion: string }>;
  }
  ```
- `mapper.ts`:
  ```ts
  export function labelsOf(note: EtapiNote): Labels;                  // last label wins per name
  export function toProject(n: EtapiNote): Project;
  export function toWorkstream(n: EtapiNote): Workstream;
  export function toMilestone(n: EtapiNote): Milestone;               // order = parseInt(labels.order) || 0
  export function toTask(n: EtapiNote): Task;                         // status defaults "todo" if not in vocabulary; round/order default 0; dependsOn = split(",") trimmed non-empty
  export function toDoc(n: EtapiNote): Doc;                           // format: type==="text" → "html"; else mime includes "markdown" → "markdown"; else "html"
  export function toReview(n: EtapiNote): Review;                     // verdict defaults "PENDING"
  export function toAgentRun(n: EtapiNote): AgentRun;
  export function fingerprint(notes: EtapiNote[]): string;            // sha256 hex over sorted `${noteId}|${utcDateModified}|${status}|${agentId}|${round}` lines
  ```

- [ ] **Step 1: Write fixtures** mirroring the spec hierarchy: one project, one workstream `demo`, milestones M1/M2, tasks T-001..T-004 with statuses `done, reviewing, todo, needs-human` (T-002 has `round=1`, `agentId=a1`), one task with NO status label and `order="x"`, docs (goal html text note, spec text note, one `code` note with mime `text/x-markdown`), reviews for T-002 round 1 (security PASS, code CHANGES, ux/ui-design missing), runs (one running builder with `agentId=a1 taskId=T-002`).
- [ ] **Step 2: Write failing mapper tests** — each `to*` on its fixture; defaults for the malformed task; `fingerprint` identical for same input in different order, different when one `utcDateModified` changes.
- [ ] **Step 3: Write failing client test** — injected `fetchImpl` records URL + headers: `search("#factoryTask", { ancestorNoteId: "ws1", orderBy: "utcDateModified", orderDirection: "desc", limit: 200 })` → URL contains `/etapi/notes?search=%23factoryTask&ancestorNoteId=ws1&orderBy=utcDateModified&orderDirection=desc&limit=200` and header `Authorization: tok`; non-2xx → rejects with `TriliumError` carrying status; `getContent` returns `mime` from `content-type`.
- [ ] **Step 4: Run → FAIL. Step 5: Implement both files. Step 6: Run → PASS.**
- [ ] **Step 7: Commit** — `git commit -m "feat(dashboard): trilium etapi client and note mapper"`

---

### Task 3: Transcript parser

**Files:**
- Create: `dashboard/src/agents/parser.ts`, `dashboard/test/fixtures/transcripts/agent-sample.jsonl`, `dashboard/test/fixtures/transcripts/agent-sample.meta.json`
- Test: `dashboard/test/parser.test.ts`

**Interfaces:**
- ```ts
  export function parseLine(line: string, seq: number): Step[];          // [] for ignored/invalid lines; one Step per content block; seq increments per step returned (seq, seq+1, …)
  export function summarizeTool(name: string, input: unknown): string;   // Bash: input.description ?? first 80 chars of input.command; Read/Edit/Write/NotebookEdit: input.file_path; Glob/Grep: input.pattern; Agent: input.description; WebFetch: input.url; else JSON.stringify(input).slice(0,80)
  export function parseTranscript(text: string): { steps: Step[]; rest: string };  // splits on "\n", parses complete lines, returns the trailing partial line in `rest`
  ```
- Mapping: `assistant` `text` → `{kind:"text", text}`; `thinking` → `{kind:"thinking"}`; `tool_use` → `{kind:"tool", tool:{name, summary}, toolUseId: block.id}`; `user` `tool_result` → `{kind:"result", toolUseId: block.tool_use_id, isError: !!block.is_error}`; plain-string `user` content → ignored; `ts` from top-level `timestamp` (fallback `new Date().toISOString()`).

- [ ] **Step 1: Build the fixture** by scrubbing a real transcript: `head -40 ~/.claude/projects/-Users-kemo-Development-kemo-design-system/d84de1f9-1a0f-47f1-8a7c-0493a5678e0d/subagents/agent-a58d95af664994f41.jsonl` → replace file paths and content with placeholders, keep structure; append one `api-request` line, one `attachment` line, one malformed line `{"type":"assistant"` and a final partial line without newline.
- [ ] **Step 2: Write failing tests** — counts per kind match the fixture; a Bash `tool_use` with `description` summarizes to it; `tool_result` with `is_error:true` → `isError`; malformed and `api-request*` lines yield `[]`; `parseTranscript` returns `rest` equal to the partial final line; feeding `rest + "\n"` later parses it.
- [ ] **Step 3: Run → FAIL. Step 4: Implement. Step 5: Run → PASS. Step 6: Commit** — `git commit -m "feat(dashboard): transcript step parser"`

---

### Task 4: Config, repo registry, event hub, poller

**Files:**
- Create: `dashboard/src/config.ts`, `dashboard/src/repos.ts`, `dashboard/src/hub.ts`, `dashboard/src/trilium/poller.ts`
- Test: `dashboard/test/config.test.ts`, `dashboard/test/poller.test.ts`

**Interfaces:**
- `config.ts`: `export interface DashboardConfig { triliumUrl: string; etapiToken: string; port: number; pollMs: number; configDir: string; homeDir: string }`; `export function loadConfig(env = process.env): DashboardConfig` (file then env overrides; throws `Error("no config")` when neither gives `triliumUrl`+`etapiToken`).
- `repos.ts`: `export interface RepoEntry { repoPath: string; repoSlug: string; projectNoteId?: string; activeWorkstream?: string; workstreams: Record<string,{noteId:string}> }`; `export class RepoRegistry { constructor(opts?: { readConfig?: (repoPath: string) => RepoEntry|null }); register(repoPath: string): RepoEntry|null /* null when no .factory/config.json */; get(repoPath): RepoEntry|undefined; bySlug(slug): RepoEntry|undefined; list(): RepoEntry[] }`; `repoSlug = basename(repoPath)`; default `readConfig` reads `<repoPath>/.factory/config.json`.
- `hub.ts`: `export class EventHub { subscribe(repoKey: string, fn: (e: StreamEvent) => void): () => void; publish(repoKey: string, e: StreamEvent): void; count(repoKey): number }`.
- `poller.ts`:
  ```ts
  export interface PollerDeps { client: TriliumClient; hub: EventHub; live: () => LiveAgent[]; now?: () => Date }
  export class Poller {
    constructor(repo: RepoEntry, deps: PollerDeps, opts?: { intervalMs?: number });
    start(): void; stop(): void;
    snapshot(): WorkstreamSnapshot | null;
    lastError(): string | null;
    refresh(): Promise<boolean>;          // runs the search set, maps, computes fingerprint; publishes {type:"snapshot"} and returns true only when fingerprint changed; on error: keeps snapshot, sets lastError, returns false
    selectWorkstream(slug: string): void; // changes the active workstream for this poller, forces refresh
  }
  ```
- Search set per `refresh()`: project by id (`getNote(projectNoteId)`) or `search("#factoryProject #repoPath='<path>'")` when id missing; then with `ancestorNoteId=projectNoteId`: `#factoryWorkstream`; pick workstream = `repo.activeWorkstream` else first; then with `ancestorNoteId=wsId`: `#factoryMilestone`, `#factoryTask`, `#factoryDoc`, `#factoryReview`, `#factoryAgentRun` (orderBy `utcDateModified` desc, limit 200). Docs at project level (goal, standards, examination, log) come from a `#factoryDoc` search with `ancestorNoteId=projectNoteId, ancestorDepth="eq1"`.

- [ ] **Step 1: Write failing config test** — temp config dir + env overrides precedence; missing → throws `no config`.
- [ ] **Step 2: Write failing poller test** — fake `TriliumClient` (object with `search`/`getNote` stubs returning fixtures from Task 2, callable with a mutable "version" so the second call changes one `utcDateModified`); hub subscriber counts snapshots: first `refresh()` → true + 1 snapshot; second with no change → false, still 1; third after mutation → true, 2; stub throwing `TriliumError` → `refresh()` false, `snapshot()` unchanged, `lastError()` set; next successful refresh clears `lastError()`.
- [ ] **Step 3: Run → FAIL. Step 4: Implement the four files. Step 5: Run → PASS. Step 6: Commit** — `git commit -m "feat(dashboard): config, repo registry, event hub, trilium poller"`

---

### Task 5: Server, API routes, fake ETAPI, first integration test

**Files:**
- Create: `dashboard/src/server.ts`, `dashboard/src/app.ts`, `dashboard/src/routes/api.ts`, `dashboard/test/integration/fake-etapi.ts`, `dashboard/test/integration/server.test.ts`
- Test: `dashboard/test/integration/server.test.ts`

**Interfaces:**
- `app.ts`: `export interface AppDeps { config: DashboardConfig; client: TriliumClient; repos: RepoRegistry; hub: EventHub; registry: AgentRegistry /* Task 6; stub type `{ list(): {live: LiveAgent[]; recent: LiveAgent[]} }` until then */; homeDir: string }`; `export function createApp(deps: AppDeps): { fetch: (req: Request) => Promise<Response>; routes: Record<string, unknown>; pollers: Map<string, Poller>; addRepo(path: string): RepoEntry|null; stop(): void }`.
- `server.ts`: `const app = createApp(…); Bun.serve({ hostname: "127.0.0.1", port: config.port, routes: app.routes, fetch: app.fetch, development: process.env.FACTORY_DEV === "1" })`; logs `factory-dashboard listening on http://127.0.0.1:<port>`.
- Routes (Task 5 scope): `GET /api/health` → `{ ok: true, pid, uptimeSec, version, trilium: { ok: boolean, url: string, error?: string }, repos: string[] }` (trilium.ok = no poller has `lastError()`; url is the configured base without token); `GET /api/repos` → `{ repos: RepoEntry[] & { workstreams: {slug,noteId}[] } }`; `POST /api/repos {path}` → 201 entry or 404 `{error:"no .factory/config.json"}`; `GET /api/state?repo=<path|slug>&ws=<slug>` → snapshot (404 if unknown repo; 503 `{error}` if no snapshot yet); `GET /api/docs/:noteId` → `{ noteId, title, format, content, modified }` with `ETag: "<utcDateModified>"` and 304 on matching `If-None-Match`; `GET /api/tasks/:noteId` → `{ task, spec?: {content, format}, reviews: Review[], approval?: {content}, runs: AgentRun[] }` (spec/approval found via `getNote(task).childNoteIds` + labels `factoryDoc=task-spec|approval`).
- `fake-etapi.ts`: `export function startFakeEtapi(fixtures: { notes: EtapiNote[]; contents: Record<string,string>; token?: string }): { url: string; token: string; stop(): void; notes: EtapiNote[]; calls: string[] }` — Bun.serve on port 0 implementing `/etapi/app-info`, `/etapi/notes?search=` (supports `#label` and `#label='value'` terms ANDed, `ancestorNoteId` via parent chain, `limit`), `/etapi/notes/:id`, `/etapi/notes/:id/content` (`Content-Type: text/html` or `text/x-markdown`); 401 when `Authorization` ≠ token.
- Integration test harness: `startFakeEtapi(fixtures)` + temp repo dir with `.factory/config.json` `{projectNoteId, activeWorkstream:"demo"}` + `createApp` served on port 0; `fetch` the endpoints.

- [ ] **Step 1: Write fake ETAPI (it is test infrastructure; a short unit test proves label+ancestor filtering).**
- [ ] **Step 2: Write failing integration tests** — health ok; `/api/state` returns 4 tasks with the expected columns; `/api/docs/<spec>` twice → 200 then 304; `/api/tasks/<T-002>` lists 2 reviews; wrong token in config → health `trilium.ok=false` with `error` containing `401` and process still answering.
- [ ] **Step 3: Run → FAIL. Step 4: Implement `app.ts`, `routes/api.ts`, `server.ts`. Step 5: Run → PASS; also `bun dashboard/src/server.ts` manually with `FACTORY_TRILIUM_URL=<fake>` prints the listening line.**
- [ ] **Step 6: Commit** — `git commit -m "feat(dashboard): server, api routes, fake etapi integration test"`

---

### Task 6: Event ingest, agent registry, transcript path + tailer

**Files:**
- Create: `dashboard/src/routes/events.ts`, `dashboard/src/agents/registry.ts`, `dashboard/src/agents/transcript-path.ts`, `dashboard/src/agents/tailer.ts`
- Test: `dashboard/test/registry.test.ts`, `dashboard/test/transcript-path.test.ts`, `dashboard/test/tailer.test.ts`, extend `server.test.ts`

**Interfaces:**
- `transcript-path.ts`: `export function cwdSlug(cwd: string): string` (every char not `[A-Za-z0-9]` → `-`); `export function resolveTranscriptPath(opts: { homeDir: string; cwd: string; agentId: string; sessionId?: string }): string | null` (`<home>/.claude/projects/<slug>/<sessionId>/subagents/agent-<id>.jsonl` if it exists; else glob `<home>/.claude/projects/<slug>/*/subagents/agent-<id>.jsonl`; else `null`); `export function readMeta(path: string): { agentType?: string; description?: string; model?: string; finished?: boolean } | null` (sibling `.meta.json`, optional keys).
- `registry.ts`: `export class AgentRegistry { constructor(opts?: { recentCap?: number; recentTtlMs?: number; now?: () => number }); start(e: { agentId; agentType; cwd; sessionId?; description?; model? }): LiveAgent /* taskNoteId parsed from description `[task:<id>]` */; stop(agentId: string, patch?: { transcriptPath?: string }): LiveAgent|undefined; touch(agentId: string, patch: Partial<LiveAgent>): LiveAgent|undefined; get(agentId): LiveAgent|undefined; list(cwd?: string): { live: LiveAgent[]; recent: LiveAgent[] }; prune(): void }`.
- `tailer.ts`: `export class TranscriptTailer { constructor(path: string, onStep: (s: Step) => void, opts?: { pollMs?: number; retryMs?: number; maxRetries?: number }); start(): void; stop(): void; readonly steps: Step[] /* ring buffer cap 2000 */ }` — reads from the last offset with `fs.openSync/readSync`, keeps `rest` from `parseTranscript`, uses `fs.watch` when available plus a `pollMs` (500) timer; if the file does not exist yet, retries every `retryMs` (1000) up to `maxRetries` (30).
- `events.ts`: `export function handleEvent(body: unknown, deps: { repos: RepoRegistry; registry: AgentRegistry; hub: EventHub; tailers: Map<string, TranscriptTailer>; homeDir: string; addRepo: (p: string) => RepoEntry|null; refresh: (repoKey: string) => void }): Response` — 400 on non-object or missing `event`/`project`; `subagent-start` → `registry.start` + resolve transcript (retry via tailer) + start tailer whose `onStep` publishes `{type:"step"}` and `registry.touch(stepCount)`; publish `{type:"agent", op:"start"}`; `subagent-stop` → `registry.stop` (use `payload.agent_transcript_path` to start a tailer if none yet, read the remainder, then stop), publish `op:"stop"`; `stage|task|agent|session-start` → publish nothing but call `deps.refresh(repoKey)` (app.ts implements it as a 250 ms-debounced `poller.refresh()`); unknown repo with no `.factory/config.json` → 204 without registering; always 204 on accepted.

- [ ] **Step 1: Write failing unit tests** — `cwdSlug("/Users/kemo/.claude")` → `-Users-kemo--claude`; `resolveTranscriptPath` with a temp home tree (direct hit, glob hit, miss); registry start/stop/recent TTL/`[task:n1]` parsing; tailer: write 3 lines, start, expect 3+ steps; append a partial line, then complete it → one more step; file created after `start()` → steps arrive.
- [ ] **Step 2: Extend integration test** — POST `subagent-start` with `payload.cwd` = temp repo and a transcript file placed at the resolved path → `/api/agents?repo=…` shows it live with `taskNoteId`; POST `subagent-stop` → moves to `recent`; POST with unknown project dir → 204 and `/api/repos` unchanged; POST `{}` → 400.
- [ ] **Step 3: Run → FAIL. Step 4: Implement; wire `POST /api/events`, `GET /api/agents`, `GET /api/agents/:id/steps?after=` into `app.ts`. Step 5: Run → PASS.**
- [ ] **Step 6: Commit** — `git commit -m "feat(dashboard): hook event ingest, agent registry, transcript tailer"`

---

### Task 7: SSE stream

**Files:**
- Create: `dashboard/src/routes/stream.ts`
- Test: extend `dashboard/test/integration/server.test.ts`

**Interfaces:**
- `export function streamRoute(req: Request, deps: { hub: EventHub; repos: RepoRegistry; snapshot: (repoKey: string) => WorkstreamSnapshot|null; live: (repoKey: string) => LiveAgent[]; heartbeatMs?: number }): Response` — `GET /api/stream?repo=<path|slug>`; headers `Content-Type: text/event-stream`, `Cache-Control: no-cache`; on connect immediately sends `event: snapshot` (if any) then `event: agent` for each live agent; forwards hub events as `event: <type>\ndata: <json>\n\n`; `event: heartbeat` every `heartbeatMs` (15 000); unsubscribes and clears the timer on `req.signal` abort.

- [ ] **Step 1: Write failing integration test** — open the stream with `fetch`, read with a `TextDecoder` reader; first chunk contains `event: snapshot`; POST a `subagent-start` event → a chunk with `event: agent`; set `heartbeatMs: 50` in test deps → a `heartbeat` arrives; abort the controller → `hub.count(repo)` returns 0.
- [ ] **Step 2: Run → FAIL. Step 3: Implement with a `ReadableStream` whose `start` subscribes and `cancel` unsubscribes. Step 4: Run → PASS. Step 5: Commit** — `git commit -m "feat(dashboard): sse stream"`

---

### Task 8: Web app — store, stream client, Kanban, docs tabs

**Files:**
- Create: `dashboard/web/index.html`, `dashboard/web/main.tsx`, `dashboard/web/app.tsx`, `dashboard/web/styles.css`, `dashboard/web/lib/store.ts`, `dashboard/web/lib/stream.ts`, `dashboard/web/lib/render.ts`, `dashboard/web/components/Kanban.tsx`, `dashboard/web/components/DocsTabs.tsx`
- Modify: `dashboard/src/app.ts` (route `/` and `/*` non-API paths to the HTML import)
- Test: `dashboard/test/store.test.ts` (pure reducer), manual check in browser.

**Interfaces:**
- `store.ts`: `export interface State { repo?: string; ws?: string; snapshot: WorkstreamSnapshot|null; live: Record<string, LiveAgent>; steps: Record<string, Step[]>; connected: boolean; selectedTask?: string; tab: string }`; `export function reduce(state: State, e: StreamEvent | { type:"connected"; data: boolean } | { type:"select-task"; data?: string } | { type:"tab"; data: string }): State` (steps ring cap 500 per agent); `export const store = createStore(reduce)` exposing `useStore(selector)` via `useSyncExternalStore`.
- `stream.ts`: `export function connect(repo: string, dispatch: (e) => void): () => void` — `EventSource('/api/stream?repo=…')`, listeners for the four event names, reconnect with backoff (1 s → 10 s), dispatch `connected`.
- `render.ts`: `export function toSafeHtml(content: string, format: "html"|"markdown"): string` — `marked.parse` for markdown then `DOMPurify.sanitize` (both formats).
- `app.tsx`: repo/workstream selector (from `/api/repos`), tab bar `Board | Goal | Standards | Overview | Spec | Plan | UI/UX | API | Validation | Agents | Mockups` (doc tabs enabled only when the doc exists in `snapshot.docs` by `kind`), URL hash `#/<tab>` kept in sync.
- `Kanban.tsx`: columns from `COLUMN_ORDER`; cards via `columnFor` + `sortTasks`; card shows title, milestone chip, `agentId`→live agent type/model when running (pulse), round `R<n>` when > 0, elapsed `mm:ss` from `live.startedAt` ticked each second, four reviewer chips in the Reviewers column coloured by the round's `Review.verdict` (`PENDING` grey, `PASS` green, `CHANGES` red; missing = outline); `needs-human` cards show the `escalation` badge; click → `select-task`.
- `DocsTabs.tsx`: lazy `GET /api/docs/:id` on tab open, `If-None-Match` cache in memory, renders `toSafeHtml`.

- [ ] **Step 1: Write failing store tests** — snapshot replaces; `agent start/stop` updates `live`; `step` appends with cap 500; `select-task` toggles.
- [ ] **Step 2: Run → FAIL. Step 3: Implement all files (apply the mockup's look from Task 0 and the user's feedback). Step 4: Run → PASS; `bun dashboard/src/server.ts` against `bun dashboard/test/integration/fake-etapi.ts --serve` (add a `--serve` entry that keeps the fake running on a fixed port and prints its URL) and verify in the browser: board renders the fixture, cards sit in the right columns, tabs show docs.**
- [ ] **Step 5: Commit** — `git commit -m "feat(dashboard): react kanban board and document tabs"`

---

### Task 9: Task drawer, agents view, steps, mockups route

**Files:**
- Create: `dashboard/web/components/TaskDrawer.tsx`, `dashboard/web/components/Agents.tsx`, `dashboard/web/components/Steps.tsx`, `dashboard/web/components/Mockups.tsx`, `dashboard/src/routes/mockups.ts`
- Test: extend `server.test.ts` (mockups route), manual browser check.

**Interfaces:**
- `mockups.ts`: `export function mockupsRoute(req: Request, deps: { repos: RepoRegistry }): Promise<Response>` — `GET /mockups/:repoSlug/*`; resolves `<repoPath>/.factory/mockups/<rest>` with `path.resolve` and rejects (404) any resolved path not inside `<repoPath>/.factory/mockups/`; directory → `index.html`; unknown slug → 404; `Bun.file` streaming with content-type by extension.
- `TaskDrawer.tsx`: on `selectedTask` fetch `/api/tasks/:id`; sections Spec (rendered), Reviews grouped by round (verdict chip + content), Approval, Runs; live Steps for the task's running agent (`live` where `taskNoteId === task.id`) using `Steps.tsx`.
- `Steps.tsx`: list of steps: text as paragraphs, tool as `▸ <name> — <summary>`, result as ✓/✗ icon attached to the preceding tool by `toolUseId`, thinking collapsed into a "thinking…" count; autoscroll when at bottom.
- `Agents.tsx`: live and recent lists with type, model, task link, elapsed, step count; click → steps panel (`GET /api/agents/:id/steps` for history then live via store).
- `Mockups.tsx`: iframe `/mockups/<repoSlug>/<activeWorkstream>/` with a "no mockups yet" fallback (HEAD request 404).

- [ ] **Step 1: Write failing mockups-route tests** — file served; `index.html` for directory; `../` traversal → 404; unknown slug → 404.
- [ ] **Step 2: Run → FAIL. Step 3: Implement route + components; wire `/mockups/:repoSlug/*` in `app.ts`. Step 4: Run → PASS; browser check with the fixture and a hand-made `.factory/mockups/demo/index.html`.**
- [ ] **Step 5: Commit** — `git commit -m "feat(dashboard): task drawer, agents view, live steps, mockups"`

---

### Task 10: Daemon and `bin/factory-dashboard` lifecycle

**Files:**
- Create: `dashboard/src/daemon.ts`, `dashboard/scripts/verify.md`, `dashboard/scripts/send-event.sh`
- Modify: `bin/factory-dashboard` (plugin plan Task 9 shim already execs `daemon.ts`; remove the "not built" guard)
- Test: `dashboard/test/daemon.test.ts`

**Interfaces:**
- `daemon.ts` CLI: `start [--port N] [--open]`, `stop`, `status`, `open`, `restart`. Files under `<configDir>/dashboard.pid` and `<configDir>/dashboard.log` (`configDir` from `loadConfig`; env `FACTORY_CONFIG_DIR` honoured for tests). `start`: if pid alive and `GET /api/health` ok → print `{"running":true,"port":N,"pid":P,"url":…}` exit 0; else `Bun.spawn(["bun", serverPath], { detached: true, stdio: ["ignore", log, log], env })` + `unref()`, write pid, poll health every 200 ms up to 10 s, print status; non-zero exit and `{"running":false,"error":…}` when health never comes up (include last 20 log lines). `stop`: `process.kill(pid, "SIGTERM")`, wait ≤ 5 s, remove pidfile. `status`: JSON. `open`: `open`/`xdg-open` the URL.
- `send-event.sh`: `send-event.sh <kind> [json-file]` → `curl -s -X POST localhost:$PORT/api/events …` for manual testing.

- [ ] **Step 1: Write failing daemon test** — with `FACTORY_CONFIG_DIR` temp, `FACTORY_TRILIUM_URL` = fake ETAPI, `FACTORY_DASHBOARD_PORT` = free port: `bun dashboard/src/daemon.ts start` exits 0 and prints `running:true`; second `start` → `running:true` same pid; `status` matches; `stop` → pid gone, health connection refused.
- [ ] **Step 2: Run → FAIL. Step 3: Implement `daemon.ts`; update the shim; write `verify.md` (manual checklist: start twice, open, send-event with a real transcript path, stop) and `send-event.sh`. Step 4: Run → PASS; run the manual checklist once.**
- [ ] **Step 5: Commit** — `git commit -m "feat(dashboard): detached daemon lifecycle"`

---

### Task 11: End-to-end with the plugin (joint smoke)

- [ ] **Step 1:** With the plugin plan complete, in the smoke repo run `/factory:run` through setup → examine → set-standards → enforce-standards → brainstorm → plan → validate → execute for one task with the dashboard open; confirm the card moves Backlog → Spec Writer → Builder → Reviewers (chips fill in) → Approver → Done, the drawer shows the live steps of the builder, and the Agents tab lists the four reviewers running concurrently.
- [ ] **Step 2:** Record any mismatch between the orchestrator's labels and the dashboard's expectations as a bug in whichever side deviates from `trilium-schema.md`; fix; re-run.
- [ ] **Step 3: Commit** — `git commit -m "chore: end-to-end smoke verified"`

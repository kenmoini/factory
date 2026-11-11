export type TaskStatus = "todo"|"spec"|"building"|"reviewing"|"fixing"|"approving"|"merging"|"done"|"needs-human"|"blocked";
export type Column = "backlog"|"spec-writer"|"builder"|"reviewers"|"approver"|"needs-human"|"done";
export type Reviewer = "security"|"ux"|"ui-design"|"code";
export type Labels = Record<string, string>;
export interface Project { id: string; title: string; repo: string; repoPath: string; labels: Labels; modified: string }
export interface Workstream { id: string; slug: string; title: string; status: string; labels: Labels; modified: string }
export interface Milestone { id: string; milestoneId: string; title: string; order: number; status: string; modified: string }
export interface Task { id: string; taskId: string; title: string; status: TaskStatus; milestoneId: string; order: number; round: number; agentId?: string; builderAgentId?: string; escalation?: string; dependsOn: string[]; modified: string }
/** `round` is set on validation rounds (`#factoryValidation`, kind "validation") only. */
export interface Doc { id: string; kind: string; title: string; format: "html"|"markdown"; parentId?: string; modified: string; round?: number }
export interface Review { id: string; taskId: string; round: number; reviewer: Reviewer; verdict: "PASS"|"CHANGES"|"PENDING"; modified: string }
/** `workstream` is the run's `#workstream` slug; runs written before the label existed have none. */
export interface AgentRun { id: string; title: string; agentType: string; agentId?: string; status: "running"|"done"|"failed"; taskId?: string; workstream?: string; startedAt?: string; endedAt?: string }
/** `repoKey` is the resolved `project` of the event that started the agent: the repo it belongs to (its `cwd` may be a worktree). */
export interface LiveAgent { agentId: string; agentType: string; description?: string; model?: string; taskNoteId?: string; cwd: string; repoKey?: string; sessionId?: string; startedAt: string; finishedAt?: string; transcriptPath?: string; stepCount: number }
export interface Step { seq: number; ts: string; kind: "text"|"thinking"|"tool"|"result"; text?: string; tool?: { name: string; summary: string }; toolUseId?: string; isError?: boolean }
/** `workstream` is the one on screen; `workstreams` lists every workstream note of the project (the UI's picker). */
export interface WorkstreamSnapshot { project: Project; workstream: Workstream|null; workstreams: Workstream[]; milestones: Milestone[]; tasks: Task[]; docs: Doc[]; reviews: Review[]; runs: AgentRun[]; live: LiveAgent[]; fingerprint: string }
/** `GET /api/tasks/:id`: the task with its spec and approval note bodies, and its reviews and runs from the snapshot. */
export interface TaskDetail { task: Task; spec?: { content: string; format: "html"|"markdown" }; reviews: Review[]; approval?: { content: string }; runs: AgentRun[] }
/** `session` and `pid` name the Claude Code session that sent the event and its process, when the hook knows them. */
export interface HookEvent { event: string; ts: string; project: string; stage?: string; status?: string; task?: string; workstream?: string; session?: string; pid?: number; payload: Record<string, unknown> }
/** A branch's worktree checkout: `dirty` is the number of changed or untracked entries. */
export interface RepoWorktree { path: string; dirty: number }
/** `ahead`/`behind` are counts against the default branch; `worktree` is set when the branch is checked out somewhere. */
export interface RepoBranch { name: string; sha: string; isDefault: boolean; ahead: number; behind: number; worktree?: RepoWorktree }
/** A factory task a commit belongs to, from a `Task:` trailer or a merge subject. */
export interface TaskRef { slug: string; taskId: string }
/** `branches` and `tags` list the refs whose tip is this commit. */
export interface RepoCommit { sha: string; short: string; parents: string[]; subject: string; author: string; authorTs: string; branches: string[]; tags: string[]; tasks: TaskRef[]; isMerge: boolean }
/** The Repo tab's payload; `truncated` is set when history was cut at `limit`, `error` when git could not be read. */
export interface RepoSnapshot { repoPath: string; defaultBranch: string; branches: RepoBranch[]; commits: RepoCommit[]; limit: number; truncated: boolean; fingerprint: string; error?: string }
/** One file of a commit's numstat; binary files carry 0/0 counts. */
export interface CommitFile { path: string; added: number; deleted: number; binary?: boolean }
/** `GET` commit detail: the commit with its message body, changed files, totals and parent summaries. */
export interface CommitDetail { commit: RepoCommit; body: string; files: CommitFile[]; totals: { files: number; added: number; deleted: number }; parents: { sha: string; short: string; subject: string }[] }
export type StreamEvent = { type:"snapshot"; data: WorkstreamSnapshot } | { type:"agent"; data:{ op:"start"|"update"|"stop"; agent: LiveAgent } } | { type:"step"; data:{ agentId: string; step: Step } } | { type:"heartbeat"; data:{ ts: string } } | { type:"repo"; data: RepoSnapshot };

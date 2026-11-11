# Dashboard "Repo" tab — design

**Date:** 2026-11-10 · **Status:** approved design, awaiting plan · **Mockup:** `dashboard/mockup/repo.html`
(option A "Rail", chosen by the user from three directions on 2026-11-10) · **Parent design:**
`docs/superpowers/specs/2026-11-10-factory-plugin-design.md` (dashboard section)

## Intent

The dashboard shows what the factory is doing in Trilium terms (board, documents, agents) but not in git terms.
The factory's git shape is simple and worth seeing at a glance: `main`, one branch plus one worktree per
workstream, builder commits on the branch, a `--no-ff` merge into `main` per approved task. The Repo tab draws
that as linked nodes, and clicking a commit shows its details in a drawer that slides in from the right, the way
the Kanban task drawer does. A glance mid-run answers: which worktrees exist, what each builder has committed,
what has merged, and whether a worktree has uncommitted work.

## Goals

- Branches, worktrees and commits of the registered repo as a rail graph: newest commit on top, one coloured
  rail per branch, merge edges curving into `main`.
- Commit drawer: message, changed files with +/− counts, worktree facts, factory context (task, milestone,
  status, link to the board card), parents.
- Live link to the rest of the dashboard: task chips on rows, a lamp pulse on a branch a builder is working on,
  "open on board" from the drawer.
- Zero configuration: everything comes from the local git repository the dashboard already has registered.
- Cheap refresh: a short poll that pushes an update only when a ref, worktree head or dirty count changed.

## Non-goals

- Rendering diff content. "Show diff" lists files with +/− counts only (user decision, 2026-11-10). The full diffs
  stay in the review packages the factory writes under `.factory/tasks/`.
- Remote branches, push state, pull requests. The factory never pushes; remotes are not shown.
- Any write to the repository. The tab is read-only.
- A general-purpose git client. Histories the factory did not produce must render without error, but the layout
  is tuned for the factory's shape (trunk plus short-lived branches), not for octopus merges or hundreds of
  concurrent branches.

## Anti-goals

- Polling that makes a large repo feel slow: no `git status` storms, no unbounded logs.
- A second source of truth for task state. Task status comes from the Trilium snapshot the dashboard already
  holds; the Repo tab only joins commits to tasks.
- New runtime dependencies. The rail is hand-drawn SVG; no d3, no graph library.

## Constraints

- Bun ≥ 1.2.10, React 19, TSX bundled by `Bun.serve` HTML imports; tests with `bun test` under `dashboard/test`
  (no network; git fixtures are temp repos created in the test).
- The dashboard's design tokens and class vocabulary (`dashboard/web/styles.css`, ported from
  `dashboard/mockup/board.html`) are reused; `dashboard/mockup/repo.html` is the visual contract.
- Loopback-only server with the existing Host guard; every new endpoint takes `?repo=<path>` and serves only a
  registered repo, like `/api/state`.
- git is invoked without a shell, with `--no-pager`, `GIT_TERMINAL_PROMPT=0`, a 10 s timeout and a bounded
  output size; every path handed to git comes from `git worktree list`, every sha is validated, every branch
  name is checked against the names git itself returned.

## What was decided

### Data model (`dashboard/src/shared/types.ts`)

- `RepoBranch { name; sha; isDefault; ahead; behind; worktree?: { path; dirty } }` — `ahead`/`behind` are
  against the default branch (`main`, else `master`); `dirty` is the number of changed or untracked paths in
  that worktree's working tree. The default branch's own `worktree` is the repo root; `ahead`/`behind` are 0.
- `RepoCommit { sha; short; parents: string[]; subject; author; authorTs; branches: string[]; tags: string[];
  tasks: { slug; taskId }[]; isMerge }` — `branches` and `tags` are the refs whose tip is this commit (chips are
  drawn only on tip rows). Task ids are unique only within a workstream (`#taskId` in the schema), so every task
  reference carries its workstream slug: `tasks` come from `Task: <slug>/<taskId>` git trailers and from factory
  merge subjects (`Merge <slug>: <taskId> <title>`). A commit with neither has no task chip.
- `RepoSnapshot { repoPath; defaultBranch; branches: RepoBranch[]; commits: RepoCommit[]; limit; truncated;
  fingerprint; error?: string }` — `commits` is the log across all local branches (or one branch when filtered),
  newest first, at most `limit`.
- `CommitDetail { commit: RepoCommit; body; files: { path; added; deleted; binary? }[]; totals: { files; added;
  deleted }; parents: { sha; short; subject }[] }`.
- `StreamEvent` gains `{ type: "repo"; data: RepoSnapshot }`.

### Server

- `dashboard/src/git/parse.ts` — pure parsers, unit-tested on captured output: `for-each-ref`, `worktree list
  --porcelain`, the log record format (`%H%x1f%P%x1f%s%x1f%an%x1f%aI%x1f%D%x1f%(trailers:key=Task,valueonly)`
  with `%x1e` record separator), `status --porcelain` counting, `show --numstat`, `rev-list --left-right --count`.
- `dashboard/src/git/reader.ts` — `GitReader` running git through `Bun.spawn` with the constraints above;
  methods `refs`, `worktrees`, `log({ limit, branch })`, `dirty(worktreePath)`, `aheadBehind(branch, base)`,
  `detail(sha)`, `defaultBranch()`. One integration test builds a temp repo with a branch, a worktree, a
  `--no-ff` merge and a `Task:` trailer and asserts the parsed snapshot.
- `dashboard/src/git/poller.ts` — `GitPoller` per registered repo, same shape as the Trilium `Poller`
  (`start`, `stop`, `refresh`, `snapshot`). Every 5 s (`FACTORY_GIT_POLL_MS`) it reads refs, worktrees and dirty
  counts, hashes them into the fingerprint and, only on change, rebuilds the snapshot and publishes a `repo`
  event through the `EventHub`. A task hook event arriving at `/api/events` for that repo triggers an immediate
  refresh (merges and commits coincide with task status changes). Failures (not a git repo, git missing) are
  reported in `snapshot.error`, never thrown to the stream.
- Routes in `dashboard/src/routes/api.ts`: `GET /api/repo?repo=<path>&limit=<n>&branch=<name>` → `RepoSnapshot`
  (`limit` default 100, clamped to 1–500; `branch` must be one of the snapshot's branch names, else 400);
  `GET /api/repo/commits/:sha?repo=<path>` → `CommitDetail` (sha must match `^[0-9a-f]{7,40}$`, unknown → 404).
  `dashboard/src/app.ts` creates and disposes a `GitPoller` next to each Trilium poller, and the SSE route sends
  the current `repo` snapshot right after the Trilium one on connect.
- Builder commits get a trailer. `agents/builder.md` and `skills/run/references/agent-protocol.md` (the git
  guardrail) say every commit message ends with the git trailer `Task: <slug>/<taskId>` (the branch name and
  the `T-001` id the brief names, e.g. `Task: checkout-flow/T-003`). Existing commits without it simply carry no
  task chip. This is the only plugin-side change.

### Web

- A `Repo` tab in `TABS` (`dashboard/web/app.tsx`) after `Validation`, before `Agents`; hash `#/repo`; `/repo`
  added to `SPA_PATHS`. The tab is always enabled (it does not depend on a Trilium document).
- `dashboard/web/lib/store.ts`: `repo: RepoSnapshot | null`, `selectedCommit?: string`, `repoView: { branch?:
  string; limit: number }`, `pendingTask?: { ws: string; taskId: string }`; actions `repo` (stream event),
  `select-commit`, `repo-view`, `open-task` (sets `pendingTask`, switches workstream and tab; the next `snapshot`
  whose workstream matches turns it into `selectedTask`); `select-repo` clears all of them. `stream.ts`
  subscribes to the `repo` event.
- View model: the poller's pushed snapshot is always the default view (all branches, limit 100). The view is
  client state: when `repoView` differs from the default, the client answers a `repo` push by refetching
  `/api/repo` with its own `branch` and `limit` (debounced 300 ms) and stores that result instead. The server
  keeps no per-view state.
- `dashboard/web/lib/rail.ts` — a pure layout, unit-tested: `layoutRail(commits, defaultBranch)` returns one row
  per commit with its `lane`, and the links to draw (`{ fromRow, toRow, fromLane, toLane, kind: "line" |
  "merge" | "fork" }`). The default branch always owns lane 0; other lanes are allocated newest-first by the
  standard rule (a commit takes the lane reserved for it by a child, else the lowest free lane; its first parent
  inherits the lane, further parents reserve new ones; lanes free up when their last commit is drawn).
  Tests pin: linear history → one lane; one branch merged with `--no-ff` → two lanes, one fork link, one merge
  link; two concurrent branches → three lanes, `main` stays lane 0.
- `dashboard/web/components/Repo.tsx` — toolbar (branch filter with `All branches` + each branch, limit
  50/100/200, legend of rail colours), the rail SVG (`Rail.tsx`, one `<path>` per link, one node per row; merge
  nodes as a larger ring; the head node of a worktree with `dirty > 0` gets a dashed outer ring) and the rows
  (short sha, subject, chips, relative time). Rows are buttons: click or Enter selects, Up/Down moves the
  selection, Escape closes the drawer; the selected row keeps the lamp-coloured inset mark from the mockup.
- `dashboard/web/components/CommitDrawer.tsx` — mirrors `TaskDrawer`: header (subject, short sha, branch and
  tag chips, task chips, lamp pulse when live), facts (worktree path, ahead/behind, dirty count), sections
  Message, Changes (files with +/−, totals in the heading), Factory (task title, milestone, status, round and
  "open on board"; the board's task drawer already shows the spec, so there is no link out to Trilium), Parents
  (each a button that selects that commit),
  and buttons Copy sha (clipboard) and Show diff (scrolls to Changes). It fetches `/api/repo/commits/:sha` on
  selection with loading, error-with-retry and "commit no longer in the log" states, like the task drawer.
- Joins happen on the client. A task chip whose slug is the on-screen workstream resolves through
  `snapshot.tasks` by `taskId` (note id, title, milestone, status, round) and reads `T-003`; one from another
  workstream reads `billing-api/T-005` and resolves nothing. "Open on board" dispatches `open-task { ws, taskId }`:
  same workstream → `tab: board` and `select-task` at once; another workstream → `select-ws`, `tab: board`, and
  the selection completes when that workstream's snapshot arrives.
- A branch is live when a `LiveAgent` in the store has a `taskNoteId` matching a task of the on-screen workstream
  and that workstream's slug is the branch name. (The hook's `cwd` is the session root, not the worktree, and
  worktrees live inside the root, so `cwd` cannot identify the branch.) The default branch never pulses.
- Styles: `.repo-panel` with the board's `drawer-open` squeeze, `.rail`, `.rail-rows`, `.row`, `.row.sel`,
  chips reuse `.ms-chip`/`.v` conventions where they fit; rail colours: `main` fixed blue, five rotating colours
  for the rest, all defined as tokens in `styles.css`. The drawer reuses `.drawer`, `.drawer-head`, `.drawer-body`,
  `.section`, `.rich` unchanged.
- States: `snapshot.error` → a panel message ("not a git repository", "git not found"); no commits → "No commits
  yet"; truncated log → a "Load more" button that bumps the limit.

### Tests

- Unit: `test/git-parse.test.ts` (every parser on captured fixtures, including `Task: <slug>/<taskId>` trailers
  and merge subjects), `test/rail.test.ts` (the three layout cases plus a 300-commit linear log to check the lane
  count stays 1), `test/store.test.ts` additions (`repo`, `select-commit`, `repo-view`, `open-task` completing on
  the matching snapshot, reset on `select-repo`).
- Integration: `test/git-reader.test.ts` on a temp repo; `test/integration/server.test.ts` additions for the two
  routes (registered repo only, sha and branch validation, 404) and for the `repo` SSE event on connect.
- Manual: `dashboard/scripts/verify.md` gains a Repo tab checklist (open tab, click row, drawer, live pulse
  while a builder runs, open on board, Load more).

## Left to the builder

- The exact lane allocator as long as the pinned tests pass and `main` stays lane 0.
- How dirty counts are obtained cheaply on big worktrees (a `status --porcelain` per worktree per poll is
  acceptable for the factory's handful of worktrees; skipping it when the worktree's HEAD and index are
  unchanged is welcome).
- Relative time formatting (reuse the board's clock helper), chip truncation, row virtualisation (not needed
  at ≤ 500 rows).
- Whether `CommitDetail.files` for a merge commit is the first-parent diff (recommended) or the combined one.

# Standard operating procedures

These apply to every stage, `run` verb and direct `/factory:<stage>` command. Read this file before the
stage file. Labels and titles are defined in `$PLUGIN_ROOT/skills/run/references/trilium-schema.md`;
agent dispatch rules in `$PLUGIN_ROOT/skills/run/references/agent-protocol.md`.

### 1. Only the orchestrator writes Trilium

- You (the session running `factory:run`) are the only writer of Trilium notes and labels; agents have no
  `mcp__trilium__*` tools and are never told to use them.
- Agents receive Markdown exports under `.factory/` and return JSON; you turn their output into notes.
- Never parse note bodies for state: decide from labels (`mcp__trilium__get_attributes`).
- Follow the find-or-create rule from the schema; never create a duplicate title under the same parent.

### 2. Every stage ends the same way

1. Write or overwrite the stage's document note (template from `$PLUGIN_ROOT/skills/run/templates/`) and
   re-export it when agents will need it: project docs to `.factory/docs/`, workstream docs to
   `.factory/workstreams/<slug>/docs/` (schema, Exports for agents).
2. `mcp__trilium__set_attribute` of the stage label on the project or workstream note (e.g. `#stageExamine=done`).
3. `mcp__trilium__append_to_note` on `Factory Log`: `- <ISO ts> [<stage>] stage done — <one-line outcome>`.
4. `factory-event stage --stage <stage> --status done --workstream <slug> </dev/null` (omit `--workstream`
   for project-level stages). A stage that stops early logs `stage stopped — <reason>` and emits `--status stopped`.

### 3. Lint, test and build commands come from Standards

- The only source is the `Standards` note labels `#lintCmd`, `#testCmd`, `#buildCmd` (read with `get_attributes`).
- Enforce-standards runs them after scaffolding; the builder receives them in its brief and runs them in the
  worktree before reporting; MERGE runs `#testCmd` on `<main>` as a post-merge smoke only when the Standards
  opt in with `#postMergeSmoke=true` (default off).
- Empty label = no such command; say "none" in briefs. Never invent a command; ask the user and update the label.

### 4. Commits and branches

- `<main>` is the default branch (`main`, else `master`; schema Placeholders). Your only commits on `<main>` are the
  two scaffolding commits: `chore: ignore factory working files` (setup's `.gitignore`) and `chore: enforce
  standards` (after `#approval=approved`).
- Builders commit only on branch `<slug>` inside `<repoPath>/.factory/worktrees/<slug>`; the api-design stage commits
  its repo API docs there too (`docs(api): <slug>`). Nobody else commits on `<main>`.
- `<main>` changes only through `factory-merge <repoPath> <slug> --message-file <file>` (`git merge --no-ff`), except
  those two scaffolding commits; never push, never open a PR.
- Never rebase, reset or force anything on `<main>`; refuse and report if `<main>` is dirty.

### 5. Graph first

- Before exploring code, read `graphify-out/GRAPH_REPORT.md` at the tree you explore (repo root or worktree).
- Use `graphify query "<question>"`, `graphify explain "<symbol>"`, `graphify path "<a>" "<b>"` before Grep/Glob.
- Stale check: if `git log -1 --format=%ct` is newer than `stat -c %Y graphify-out/graph.json 2>/dev/null || stat -f %m graphify-out/graph.json`,
  run `graphify update .` first; missing `graphify-out/` → run the `graph` stage.
- Git hooks (`graphify hook install`) refresh the graph after commits and merges; re-install if missing.

### 6. Human gates use AskUserQuestion

- Gates: Goal, Standards, Enforcement Plan, workstream Spec, Plan, UI-UX Spec, API Design, validation outcome,
  every `needs-human` task.
- Use AskUserQuestion with explicit options (e.g. `Approve / Edit / Skip stage`); never infer approval from silence.
- Record the answer in labels (`#approval`, `#verdict`) and one Factory Log line before acting on it.
- Subagents cannot talk to the user: all dialogue happens here, in the orchestrator.

### 7. Subagents get paths, not documents

- Dispatch with the brief format from `agent-protocol.md`: `Task:` (with `[task:<noteId>]` or `[task:none]`),
  `Read first:`, `Inputs:`, `Write:`, `Return:`; all paths absolute.
- Never paste document bodies into a prompt; export to a file and pass the path.
- Each agent returns ≤ 15 lines then exactly one fenced json block; parse the last json block (protocol rule).
- Every dispatch gets an Agent Run note (schema convention) and its `description` carries `[task:<noteId>]`.

### 8. The orchestrator never edits product code

- You never Write/Edit files in the product source tree or the worktree (builders do), except these allowed writes:
  `.factory/**` (exports, drafts, briefs, ledger, mockups), `.gitignore` entries (setup), approved scaffolding in
  enforce-standards, repo API docs in api-design (in the workstream worktree, path from `#apiDocPath`).
- Need a code change outside a task? Ask the user to add it to the plan (plan stage) rather than doing it.

### Context hygiene after compaction

- After a compaction, a resume or a long pause, re-read before acting: `.factory/state.json` (execute ledger),
  then `mcp__trilium__get_attributes` of the task note it names (and the workstream note).
- **Trilium wins**: when the ledger and labels disagree, rewrite the ledger from the labels (status → phase
  table in `execute-loop.md`; ledger-only fields are kept) and log `- <ISO ts> [execute] ledger resynced from Trilium`.
- Re-read this file, the current stage file and any reference you are about to apply; do not act from memory.
- Never re-dispatch an agent whose run note is `#status=running` without first checking whether its result
  already arrived in this session; if unknown, mark that run `failed` and dispatch fresh.

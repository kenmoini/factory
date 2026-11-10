---
name: run
description: Factory orchestrator — run the pipeline, show status, or approve/reject a task
argument-hint: "[status|approve <task>|reject <task> \"notes\"|<stage>] [--workstream <slug>]"
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, Agent, SendMessage, AskUserQuestion, WebSearch, WebFetch, Skill, mcp__trilium
---

## You are the orchestrator

You drive the factory pipeline from this session. You are the single writer of Trilium: only you call
`mcp__trilium__*`, and you turn agent output into notes and labels. You spawn every subagent (`factory:*` via
the Agent tool) and hold every conversation with the user through AskUserQuestion, because subagents cannot
talk to the user. You never edit product code yourself; builders do, in worktrees. Never ask whether to continue;
stop only where this file or a stage file says to.

## Plugin root

Plugin root ($PLUGIN_ROOT): ${CLAUDE_PLUGIN_ROOT}

Stage, reference and template files write this directory as the literal `$PLUGIN_ROOT/`. It is not an
environment variable: replace it with the path above everywhere you use it, including agent briefs. The `factory-*`
commands are on the Bash PATH; if one is not found, call `$PLUGIN_ROOT/bin/<name>`.

## Preflight

Preflight: !`"${CLAUDE_PLUGIN_ROOT}/bin/factory-preflight" 2>/dev/null || echo '{"error":"preflight failed"}'`

Fields: `config.global` (`~/.config/claude-factory/config.json`, or `config.json` under `FACTORY_CONFIG_DIR`,
exists), `config.repo` (`<repoPath>/.factory/config.json` exists), `config.dir` (the global config directory);
`trilium.{ok,url,version,mcpEndpoint,mcpRegistered,error}` (`url` = Trilium base URL from the global config;
`ok` = ETAPI answered; `mcpEndpoint` = `<url>/mcp` answers; `mcpRegistered` = `claude mcp get trilium` succeeds);
`dashboard.{running,port}`; `git.{isRepo,root,branch,dirty,hasCommits}` (`root` = `<repoPath>` below; its basename = `<repoName>`, the project
note title and `#project` value; never use one for the other);
`factory.{configured,projectNoteId,activeWorkstream,worktree}`; `graphify.{installed,outPresent,ageMinutes,gitHooks}`;
`tools.{bun,uv,node,superpowers}`. A bare `{"error":…}` means the probe could not run. It is a snapshot taken at
load: after setup, an install or a config change, run `factory-preflight` again.

## Arguments

Received: `$ARGUMENTS` → verb `$0`, target `$1`, notes `$2` (shell-split; a quoted string is one word).

1. Remove `--workstream <slug>` wherever it appears and re-split the rest: the remaining words are verb, target,
   notes, in that order. The slug (`^[a-z0-9][a-z0-9-]{0,62}$`, no trailing `-`) replaces
   `factory.activeWorkstream` for this run.
2. verb ∈ {"" (none), `status`, `approve`, `reject`, `setup`, `examine`, `set-standards`, `enforce-standards`,
   `brainstorm`, `uiux`, `api-design`, `plan`, `validate`, `execute`, `graph`}.
3. target: the task id (`T-001`) for `approve`/`reject`; the workstream slug for `brainstorm` (optional; asked
   when absent). notes: the reason for `reject`. `brainstorm` given both a positional slug and `--workstream`: the
   positional slug wins; ignore `--workstream` with a one-line warning.
4. Unknown verb, `approve`/`reject` without a task id, `reject` without notes, or a bad slug → print usage, stop:

```
/factory:run [status | approve <task> | reject <task> "notes" | <stage>] [--workstream <slug>]
stages: setup examine set-standards enforce-standards brainstorm uiux api-design plan validate execute graph
```

## Ensure setup

Whatever the verb, run the setup stage first (Dispatch below, with `$PLUGIN_ROOT/skills/run/stages/setup.md`)
when any of these holds:
- preflight `error`, `config.global=false`, `config.repo=false`, or no `factory.projectNoteId`;
- `trilium.ok=false` or `trilium.mcpRegistered=false`;
- no `mcp__trilium__*` tools in this session.

If setup has just registered the Trilium MCP server (`claude mcp add`), its tools load only after a reconnect:
tell the user to run `/mcp` and reconnect `trilium` (or restart Claude Code), then re-run
`/factory:run $ARGUMENTS`, and stop. Otherwise run `factory-preflight` again and continue with the verb, unless
the verb is `setup`: then stop (it has just run).

## Dashboard

- `dashboard.running=false` → `factory-dashboard start`. If it still reports `"running":false` (e.g.
  `dashboard not built`), mention it once and continue: the dashboard never blocks a stage.
- At the start of every stage: `factory-event stage --stage <stage> --status started </dev/null` (add
  `--workstream <slug>` for workstream stages). The `done`/`stopped` event is SOP 2.

## Stage state and prerequisites

First Read `$PLUGIN_ROOT/skills/run/references/sop.md` and `$PLUGIN_ROOT/skills/run/references/trilium-schema.md`
(once per invocation, again after any compaction); every verb below relies on them.

State comes only from `mcp__trilium__get_attributes` on the project note (`factory.projectNoteId`) and on the
workstream note, never from note bodies or searches. Workstream note id: `factory-config get
workstreams.<slug>.noteId --repo <repoPath>`; on a miss use the schema's workstream search and cache the id with
`factory-config set workstreams.<slug>.noteId <id> --repo <repoPath>`.

| # | Stage | Requires | Done when |
|---|---|---|---|
| 0 | setup | – | `#stageSetup=done` |
| 1 | examine | `#stageSetup=done` | `#stageExamine=done` |
| 2 | set-standards | `#stageExamine=done` | `#stageStandards=done` |
| 3 | enforce-standards | `#stageStandards=done` | `#stageEnforce` ∈ {done, skipped} |
| 4 | brainstorm | `#stageEnforce` ∈ {done, skipped} | `#stageBrainstorm=done` |
| 5 | uiux | `#stageBrainstorm=done` | `#stageUiux` ∈ {done, skipped} |
| 6 | api-design | `#stageBrainstorm=done` | `#stageApi` ∈ {done, skipped} |
| 7 | plan | `#stageUiux` and `#stageApi` ∈ {done, skipped} | `#stagePlan=done` |
| 8 | validate | `#stagePlan=done` | `#stageValidate=pass` ∧ `#validatedPlanRev` = `#planRev` |
| 9 | execute | `#stageValidate=pass` ∧ `#validatedPlanRev` = `#planRev` | `#stageExecute=done` |
| – | graph | `#stageSetup=done` | `#stageGraph=done` (on demand; not in the sequence) |

Rows 0–3 and graph are project labels; rows 4–9 live on the workstream note.

- **Direct stage command** (`/factory:run <stage>` or `/factory:<stage>`): if Requires is unmet, refuse with the
  exact missing label and the note it belongs on, e.g. `Missing #stageStandards=done on project <repoName>: run
  /factory:set-standards first.`, and stop. `uiux`, `api-design`, `plan`, `validate`, `execute` with no `--workstream`
  and no `factory.activeWorkstream` → refuse `No active workstream: run /factory:brainstorm first.` and stop. A stage
  already done may run again; its stage file handles redo/realign.
- **No verb**: run the first stage in # order that is not done, then the next, and so on, pausing only at human
  gates (SOP 6). Workstream stages need a workstream: none active → brainstorm. When every stage of the active
  workstream is done, say so and AskUserQuestion `Brainstorm a new workstream / Stop`.
- `skipped` is set only from an explicit user choice (an AskUserQuestion answer); never infer it and never set it
  to unblock a prerequisite.

## Dispatch

Same path for every stage, however invoked (no verb, stage verb, `/factory:<stage>` alias):
1. `sop.md` first: already read above (read it now if you came straight from Ensure setup); re-read after compaction.
2. `trilium-schema.md`, needed before any Trilium write: already read above; re-read after compaction.
3. Read `$PLUGIN_ROOT/skills/run/stages/<stage>.md` and follow it step by step, reading the references and
   templates (`$PLUGIN_ROOT/skills/run/templates/`) it names when it names them. Every Agent dispatch follows
   `$PLUGIN_ROOT/skills/run/references/agent-protocol.md`.
4. When the stage ends (SOP 2), re-check the table: continue (no verb) or stop (direct stage verb).

Use the Skill tool only for the third-party skills `superpowers:brainstorming`, `superpowers:writing-plans` and
`graphify`, where a stage file says so; never invoke a `factory:*` skill from here.

## status

Read-only: no stage runs, no Trilium writes. Use `get_attributes` and the schema's canonical searches. Print:
1. **Stages**: one row per stage of the table above with its current label value (`–` when unset).
2. **Active workstream**: slug, `#wsStatus`, `#planRev` / `#validatedPlanRev`, worktree path; other workstreams
   with their `#wsStatus`.
3. **Tasks by status**: count per task `#status`, and the in-flight task with its phase from `.factory/state.json`.
4. **Needs human**: every `needs-human` task with its `#escalation` and `/factory:run approve <T>` (not for
   `spec-failed`) or `/factory:run reject <T> "notes"`; every `blocked` task (merge-conflict sub-flow) with
   `/factory:run execute` to resume it.

Then run `factory-dashboard open`.

## approve / reject

These resolve a `needs-human` task. They skip the prerequisite table: a realign that bumped `#planRev` must not
block resolving a parked task. With sop.md and the schema read, Read `$PLUGIN_ROOT/skills/run/stages/execute.md`,
resolve `<slug>`/`<ws>` as execute-loop.md § Preconditions step 0 (execute.md § Prerequisites points there; no
other precondition), then run only execute.md's **Human approve** section (`approve <T>`) or **Human reject** section
(`reject <T> "notes"`). It hands over to the execute loop (MERGE, SPEC or FIX); follow it until the loop stops,
then stop: never continue to the next stage. Only the user issues these verbs; never approve or reject a task on
your own.

## Working files

`<repoPath>/.factory/` (gitignored, like `graphify-out/`):
- `config.json`: `projectNoteId`, `activeWorkstream`, `workstreams.<slug>.noteId` (`factory-config get|set … --repo <repoPath>`).
- `state.json`: execute ledger; Trilium wins when they disagree.
- `docs/`: exports of the project documents (`goal`, `standards`, `examination`, `enforcement-plan`).
- `workstreams/<slug>/`: `docs/*.md` exports for agents (workstream documents plus copies of the project ones),
  `tasks.md`, drafts.
- `tasks/<slug>/<taskId>/`: brief, spec, report, review packages and results of one task.
- `mockups/<slug>/`: UI/UX option mockups served by the dashboard.
- `worktrees/<slug>/`: the workstream's git worktree on branch `<slug>` (`factory-worktree ensure|remove`).
- `examine/`: examine drafts and codebase-examiner output.
- `research/`: standards-researcher questions, answers and report; the Standards draft.
- `enforce/`: Enforcement Plan file drafts, lint/test logs and `applied.txt`.

## Stage files

All under `$PLUGIN_ROOT/skills/run/`:
- `stages/setup.md`: config, Trilium + MCP, tools, project note and Factory Log, `.factory/`, dashboard.
- `stages/examine.md`: greenfield dialogue or brownfield `codebase-examiner`; Goal (+ Codebase Examination).
- `stages/set-standards.md`: `standards-researcher` + dialogue per area; Standards with `#lintCmd`, `#testCmd`, `#buildCmd`.
- `stages/enforce-standards.md`: Enforcement Plan → approve/edit/skip → scaffold, lint/test, commit on `main`.
- `stages/brainstorm.md`: slug, workstream + worktree, `superpowers:brainstorming` → Spec, `superpowers:writing-plans` → Plan.
- `stages/uiux.md`: applicability, UX questions, option mockups in `.factory/mockups/<slug>/`; UI-UX Spec.
- `stages/api-design.md`: applicability, contracts, repo API docs at `#apiDocPath`; API Design.
- `stages/plan.md`: milestones and tasks with `#dependsOn`; realign and bump `#planRev` when tasks exist.
- `stages/validate.md`: six `plan-adversary` lenses in one message; Validation/Round N; pass, or back to plan.
- `stages/execute.md`: the per-task loop of `references/execute-loop.md`, plus Human approve / Human reject.
- `stages/graph.md`: full build via the `graphify` skill or `graphify update .`; git hooks.

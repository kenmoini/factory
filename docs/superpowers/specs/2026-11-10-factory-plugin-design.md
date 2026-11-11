# Claude Software Factory plugin (`factory`) — Design

> Approved design, 2026-11-10. Implementation plans: `docs/superpowers/plans/2026-11-10-factory-plugin.md`, `docs/superpowers/plans/2026-11-10-factory-dashboard.md`.


## Context

`/Users/kemo/Development/claude-sf` is empty. It becomes a **Claude Code plugin named `factory`**
that turns any repo into a Claude-driven "software factory":

- **Trilium** (the user's existing TriliumNext instance, reached through Trilium's built-in MCP
  server) holds all knowledge, planning and tracking under `root/ClaudeProjects/<repo>`.
- **Graphify** keeps a code graph of the target repo, refreshed after every commit, and is the
  preferred way for the orchestrator and subagents to explore code.
- A **local web dashboard** (Bun + TypeScript, React/TSX bundled on the fly, ETAPI + SSE) shows the
  workstream documents in tabs and a Kanban board of milestones / tasks / agents. Clicking a card
  shows the task's spec, reviews, approval and the live steps of the subagent working on it.
- `/factory:run` is the single entry point. The session that runs it becomes the **orchestrator**:
  it walks the stage pipeline, spawns every subagent, and is the only writer of tracked
  agents/tasks. Every stage also has a direct `/factory:<stage>` command that re-enters the
  orchestrator with "verify prior stages, then run this one" so the standard operating procedures
  (Trilium tracking, lint/test, approval gates, graphify refresh) always apply.

**Decisions confirmed with the user:** existing Trilium assumed (setup only wires MCP + token);
plugin distribution; short skill names under plugin `factory`; Trilium's built-in MCP (≥ 0.106);
React/TSX front end; one git worktree + branch per workstream named by its slug; one task at a time
with the four reviewers as the only parallelism; local `--no-ff` merge to `main`, no PR.

**Calls I made (flag if wrong):** `/factory:reject <task> "<notes>"` added next to `approve`
(needs-human without a reject path is a dead end); worktrees at `.factory/worktrees/<slug>`
(gitignored, inside the project so permissions cover it); task statuses include `fixing` and
`merging`; no `PostToolUse` hook (steps come from transcript tailing); dashboard port 7777;
bin-script tests run under `bun test` (no bats dependency); docs stored as Trilium `text` notes
written in Markdown via the MCP (readable natively in Trilium).

## Stage pipeline

| # | Stage | Skill | Output in Trilium | Prerequisite labels |
|---|-------|-------|-------------------|---------------------|
| 0 | Setup | `setup` | project note, Factory Log | – |
| 1 | Examine (greenfield → New Project flow; brownfield → Examine Codebase flow) | `examine` | `Goal` (+ `Codebase Examination`) | `stageSetup=done` |
| 2 | Set standards (research + chat) | `set-standards` | `Standards` (+ `#lintCmd #testCmd #buildCmd #ciPlatform`) | `stageExamine=done` |
| 3 | Enforce standards (plan → user approval → scaffold) | `enforce-standards` | `Enforcement Plan` + `#approval` | `stageStandards=done` |
| 4 | Brainstorm workstream (slug + overview → superpowers brainstorming + writing-plans, output to Trilium) | `brainstorm` | `Workstreams/<slug>/{Overview,Spec,Plan}` | `stageEnforce ∈ {done,skipped}` |
| 5 | UI/UX (if the plan calls for it; mockups served by dashboard) | `uiux` | `UI-UX Spec` | `stageBrainstorm=done` |
| 6 | API design (if contracts exist) | `api-design` | `API Design` + repo API docs | `stageBrainstorm=done` |
| 7 | Planner (milestones/tasks; realign if they exist) | `plan` | `Milestones/M*/T-*` | `stageUiux, stageApi ∈ {done,skipped}` |
| 8 | Validate (adversarial reviews) | `validate` | `Validation/Round N` | `stagePlan=done` |
| 9 | Execute (spec → build → 4 reviews → approve → merge) | `execute` | task sub-notes, agent runs | `stageValidate=pass ∧ validatedPlanRev=planRev` |
| – | Graph refresh | `graph` | – (`graphify-out/`) | `stageSetup=done` |
| – | Entry / status / human gate | `run` (`run`, `run status`, `run approve T-001`, `run reject T-001 "notes"`) | – | – |

`/factory:run` with no verb runs the first stage not done, then continues sequentially, pausing at
every human gate. A direct stage command refuses with the exact missing label if prerequisites are
unmet. `skipped` only comes from an explicit user choice.

## Verified facts the design rests on

**Claude Code (docs, 2026-11-10)**
- Plugin layout: `.claude-plugin/plugin.json` (`name` kebab-case), auto-discovered `skills/<name>/SKILL.md`,
  `agents/*.md`, `hooks/hooks.json`, `.mcp.json`, `bin/` (added to Bash PATH). Root `CLAUDE.md` is NOT
  loaded. Vars: `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}`. Dev load:
  `claude --plugin-dir <dir>`; CI: `claude plugin validate <dir> --strict`.
- Skills invoke as `/<plugin>:<skill>`. Frontmatter: `allowed-tools`, `argument-hint`,
  `disable-model-invocation`, `$ARGUMENTS`/`$0..$N`, `` !`cmd` `` dynamic context injection.
- Agent frontmatter: `model: fable|opus|sonnet|haiku|inherit` (fable valid; falls back if unavailable),
  `tools`, `disallowedTools`, `skills`, `maxTurns`. Plugin agents IGNORE `hooks`, `mcpServers`,
  `permissionMode`. **Subagents cannot converse with the user** → stages that chat run in the
  orchestrator's own context; subagents research/build/review only.
- Resume a subagent with `SendMessage` to its agent id (context kept) → builder fix rounds.
- Hooks: `SubagentStart` {agent_id, agent_type, session_id, cwd}; `SubagentStop` adds
  `agent_transcript_path`, `last_assistant_message`. `command` hooks support `async: true`.
- Transcripts: `~/.claude/projects/<cwd-slug>/<session>/subagents/agent-<id>.jsonl` (+ `.meta.json`),
  written live. Lines: `{"type":"assistant","timestamp","agentId","message":{"content":[{type:text|thinking|tool_use{name,input}}]}}`
  and `{"type":"user","message":{"content":[{type:tool_result,tool_use_id,is_error}]}}`; skip `api-request*`, `attachment`.
- Background Bash tool calls die after ≤ 2 h → dashboard runs as a detached daemon.
- Limits: 20 concurrent subagents, nesting depth 3.

**Trilium**
- Wiring decision (revised at planning time): no plugin `.mcp.json` and no stdio wrapper; the setup stage runs
  `claude mcp add --scope user --transport http trilium "<triliumUrl>/mcp" --header "Authorization: Bearer <token>"`.
  URL + token are also written to `~/.config/claude-factory/config.json` (mode 600) for the dashboard and preflight.
- Built-in MCP (TriliumNext ≥ 0.106; latest 0.107.0): Streamable HTTP at `<url>/mcp`, header
  `Authorization: Bearer <ETAPI token>`, enabled under Options → AI/LLM → MCP server. Tools:
  `search_notes, get_note, get_note_content, set_note_content, append_to_note, edit_note_content,
  create_note, rename_note, delete_note, get_attributes, get_attribute, set_attribute (replaces
  same-name attribute), delete_attribute, get_child_notes, get_subtree, move_note, clone_note`.
  Text notes accept Markdown. Docs: https://docs.triliumnotes.org/user-guide/llm/mcp
- ETAPI (dashboard read-only; setup checks): `GET /etapi/app-info`;
  `GET /etapi/notes?search=<q>&ancestorNoteId=<id>&orderBy=…&orderDirection=…&limit=…` → `{results: Note[]}`
  (Note has `attributes[]`, `childNoteIds`, `type`, `mime`, `utcDateModified`); `GET /etapi/notes/{id}`;
  `GET /etapi/notes/{id}/content`. Root id is `root`. Search syntax: `#factoryTask #status=todo orderBy #order`,
  `note.title = 'X'`, `note.ancestors.noteId = 'X'`. No rate limit on data endpoints.

**Graphify** (https://github.com/Graphify-Labs/graphify, Apache-2.0, 0.9.105)
- PyPI `graphifyy`, Python ≥ 3.10; install persistently with `uv tool install graphifyy` (never `uvx`).
- (`graphify install` places graphify's own `/graphify` skill; the factory does not use it) `graphify hook install` → git
  post-commit/post-checkout/post-merge/post-rewrite hooks that rebuild code-only in a detached process.
- `graphify update .` builds from scratch or incrementally (AST only, no LLM; the `/graphify .` skill build is never used); `graphify query|path|explain`;
  outputs `graphify-out/{graph.json,GRAPH_REPORT.md,graph.html}`.

**Machine:** Claude Code 2.1.322; node 26, npm, pnpm, go, python 3.14, git, jq, gh (not logged in),
podman. **Missing:** bun, uv/pipx, graphify. No local Trilium (user's instance is remote).
Superpowers 7.0.0 installed; its spec/plan locations are preference-overridable.
User settings: `defaultMode: auto`; `CLAUDE_CODE_SUBAGENT_MODEL` sits inside the `permissions`
block (probably inert — verify per-agent `model:` wins in the smoke run).

## Plugin layout

```
claude-sf/
  .claude-plugin/plugin.json        name=factory, version, description, author, keywords
  hooks/hooks.json                  SubagentStart / SubagentStop (async) + SessionStart (sync, context line)
  skills/run/SKILL.md               THE ORCHESTRATOR: arg parsing, preflight, stage dispatch, SOPs
  skills/run/stages/<stage>.md      setup, examine, set-standards, enforce-standards, brainstorm, uiux,
                                    api-design, plan, validate, execute, graph — loaded with Read
  skills/run/references/sop.md      standing procedures (tracking, lint/test, commits, gates, context hygiene)
  skills/run/references/trilium-schema.md   hierarchy, labels, canonical searches
  skills/run/references/agent-protocol.md   dispatch brief format, JSON contracts, guardrails, graphify use
  skills/run/references/execute-loop.md     state machine (below)
  skills/run/templates/*.md         goal, examination, standards, enforcement-plan, overview, uiux-spec,
                                    api-design, task-spec, build-report, review, approval, validation
  skills/<stage>/SKILL.md           11 aliases: "Invoke Skill factory:run with `<stage> $ARGUMENTS`";
                                    disable-model-invocation: true
  agents/{spec-writer,builder,security-reviewer,ux-reviewer,ui-design-reviewer,code-reviewer,approver,
          codebase-examiner,standards-researcher,plan-adversary}.md
  bin/factory-event                 sh: stdin JSON → POST localhost:<port>/api/events; 2 s cap; always exit 0; no-op without .factory/config.json
  bin/factory-preflight             sh: one JSON line {config, trilium, dashboard, git, factory, graphify}; used via !`…` in run/SKILL.md
  bin/factory-config                sh: get/set keys in global (mode 600) and repo .factory/config.json
  bin/factory-worktree              sh: ensure|remove <slug> → .factory/worktrees/<slug> on branch <slug>; refuses foreign branch
  bin/factory-review-package        sh: <worktree> <base> <head> → commits + stat + diff -U10 file; prints path
  bin/factory-merge                 sh: <repo> <branch> "<msg>" → git merge --no-ff; conflict → abort + {"result":"conflict","files":[]}
  bin/factory-dashboard             sh: start|stop|status|open → bun dashboard/src/daemon.ts (detached, pidfile, log)
  dashboard/                        see Dashboard section
  tests/bin/*.test.ts               bun test: each bin script against a temp git repo with stubbed curl/npx
  tests/fixtures/                   hook payloads, agent JSON outputs
  docs/superpowers/specs/2026-11-10-factory-plugin-design.md   design doc derived from this plan
  README.md, .gitignore, LICENSE
```

Config: `~/.config/claude-factory/config.json` `{triliumUrl, etapiToken, dashboardPort:7777}` (mode 600),
shared by the MCP wrapper and the dashboard. Repo: `.factory/config.json` `{projectNoteId,
activeWorkstream, workstreams:{<slug>:{noteId}}}`, `.factory/state.json` (execute ledger),
`.factory/workstreams/<slug>/docs/*.md` (Markdown exports of Trilium docs for subagents),
`.factory/tasks/<id>/` (briefs, specs, reports, diffs), `.factory/mockups/`, `.factory/worktrees/`.
`.factory/` and `graphify-out/` are gitignored.

## Orchestrator skill (`skills/run/SKILL.md`)

Frontmatter: `name: run`, `argument-hint: "[status|approve <task>|reject <task> \"notes\"|<stage>] [--workstream <slug>]"`,
`allowed-tools: Read, Write, Edit, Glob, Grep, Bash, Agent, SendMessage, AskUserQuestion, WebSearch, WebFetch, Skill, mcp__trilium`.

1. **Preflight** via `` !`"${CLAUDE_PLUGIN_ROOT}/bin/factory-preflight"` `` (zero turns).
2. **Parse `$ARGUMENTS`**: `$0 ∈ {"", status, approve, reject, <stage>}`, `$1` task id / slug, `$2` notes.
3. **Ensure setup**: missing config / unreachable Trilium / no `mcp__trilium__*` tools → run `stages/setup.md`
   first, whatever was asked. (The stdio wrapper starts at session start; after first config the user is told
   to `/mcp` reconnect.)
4. **Dashboard**: `bin/factory-dashboard start` if not running; `bin/factory-event stage --stage <x> --status started`.
5. **Stage state** from `get_attributes(projectNote)` / `get_attributes(workstreamNote)`; enforce the
   prerequisite table above.
6. **Dispatch**: `Read ${CLAUDE_PLUGIN_ROOT}/skills/run/stages/<stage>.md` and follow it (one code path for
   `run` and the aliases; the Skill tool is used only for third-party skills: `superpowers:brainstorming`,
   `superpowers:writing-plans`, `graphify`).
7. **SOPs** (`references/sop.md`): only the orchestrator writes Trilium; every stage ends with its note +
   `set_attribute` of the stage label + an `append_to_note` line in Factory Log; lint/test/build commands are
   labels on Standards and are read from there by builder, enforce stage and post-merge smoke; the
   orchestrator commits on `main` only for approved scaffolding, builders commit only in worktrees; before
   exploring code read `graphify-out/GRAPH_REPORT.md` and use `graphify query|explain|path`, run
   `graphify update .` if the graph is older than HEAD; human gates (enforcement plan, spec, plan, validation
   outcome, needs-human) use AskUserQuestion; subagents get file paths, never pasted documents, and return
   ≤ 15 lines + one fenced JSON block; the orchestrator never edits product code itself; after compaction
   re-read `.factory/state.json` and Trilium before acting (Trilium wins).
8. **`status`**: table of stages, active workstream, tasks by status, needs-human items; `bin/factory-dashboard open`.

## Trilium schema (`references/trilium-schema.md`)

Docs are `text` notes written in Markdown. Every tracked note carries denormalised labels
(`#project`, `#workstream`, `#taskId`) so searches never depend on ancestors.

```
ClaudeProjects                         #factoryRoot
└─ <repo>                              #factoryProject #repo #repoPath=<abs> #projectKind=greenfield|brownfield
                                       #stageSetup #stageExamine #stageStandards #stageEnforce(done|skipped) #activeWorkstream #dashboardPort
   ├─ Factory Log                      #factoryDoc=log (append_to_note, one line per event)
   ├─ Goal                             #factoryDoc=goal #approval=approved
   ├─ Codebase Examination             #factoryDoc=examination (brownfield)
   ├─ Standards                        #factoryDoc=standards #lintCmd #testCmd #buildCmd #ciPlatform #approval
   ├─ Enforcement Plan                 #factoryDoc=enforcement-plan #approval=pending|approved|rejected #appliedSha
   ├─ Agent Runs/<date> <agent> <id>   #factoryAgentRun #agentType #agentId #status=running|done|failed #startedAt #endedAt #taskId?
   └─ Workstreams/<slug>               #factoryWorkstream #slug #branch #worktree #wsStatus=brainstorm|design|planned|validated|executing|paused|done
                                       #stageBrainstorm #stageUiux #stageApi(done|skipped) #stagePlan #stageValidate=pass|fail #planRev #validatedPlanRev #stageExecute
      ├─ Overview / Spec / Plan        #factoryDoc=overview|spec|plan  #approval=approved  (Plan: #planRev)
      ├─ UI-UX Spec / API Design       #factoryDoc=uiux|api-design (#apiDocPath)
      ├─ Validation/Round N            #factoryValidation #round #verdict=pass|fail #planRev  (child note per adversary lens)
      └─ Milestones/M1 <title>         #factoryMilestone #milestoneId #order #status=todo|active|done
         └─ T-001 <title>              #factoryTask #taskId #order #milestoneId #dependsOn
                                       #status=todo|spec|building|reviewing|fixing|approving|merging|done|needs-human|blocked
                                       #round #base #head #mergedSha #builderAgentId #agentId #escalation=fix-cap|approver|builder-blocked|merge-conflict|reviewer-failed
            ├─ Task Spec               #factoryDoc=task-spec
            ├─ Build Report            #factoryDoc=build-report (append per round)
            ├─ Review R<n> <reviewer>  #factoryReview #round #reviewer=security|ux|ui-design|code #verdict=PASS|CHANGES
            ├─ Approval R<n>           #factoryDoc=approval #verdict=APPROVE|ESCALATE
            ├─ Human Decision          #factoryDoc=human-decision #verdict=approve|reject
            └─ Agent Run …             #factoryAgentRun (builder/reviewer/approver runs for this task)
```

Canonical searches: project `#factoryProject #repoPath='<abs>'`; next task
`#factoryTask #workstream='<slug>' #status=todo orderBy #order asc limit 1`; in-flight
`#factoryTask #workstream='<slug>' #status!=todo #status!=done limit 1`; blockers
`… (#status=needs-human OR #status=blocked)`; reviews `#factoryReview #taskId='T-001' #round=2`;
latest validation `#factoryValidation #workstream='<slug>' orderBy #round desc limit 1`.
Stage state is always `get_attributes`, never a search. (If `search_notes` ignores `orderBy/limit`, sort client-side.)

## Execute loop (`references/execute-loop.md`, `stages/execute.md`)

Preconditions: `stageValidate=pass`, `validatedPlanRev=planRev`, `factory-worktree ensure <slug>` ok,
`main` clean. Ledger `.factory/state.json` mirrors task/phase/round/agent ids/base/head.

| State | Action | Trilium | Next |
|---|---|---|---|
| SELECT | resume in-flight task, else next `todo` (deps done); none → FINISH | `#wsStatus=executing` | SPEC |
| SPEC | export task + plan constraints + Standards + docs to `.factory/tasks/<id>/brief.md`; spawn **spec-writer** | `#status=spec`; Agent Run; `Task Spec` note | BUILD; NEEDS_CONTEXT → answer (or ask user) → SendMessage |
| BUILD | `#base=HEAD(branch)`; spawn **builder** (worktree, spec, report path, lint/test cmds) | `#status=building #round=0 #builderAgentId` | DONE → REVIEW; NEEDS_CONTEXT → SendMessage; BLOCKED → NEEDS-HUMAN(builder-blocked) |
| REVIEW | `round+=1`; `factory-review-package` → diff file; **one message, four Agent calls** (security, ux, ui-design, code) with diff/spec/report paths (+ open findings when round > 1); wait for all | `#status=reviewing #round #head`; 4 Review notes + runs | all PASS → APPROVE; any CHANGES ∧ round ≤ 2 → FIX; CHANGES ∧ round = 3 → NEEDS-HUMAN(fix-cap); agent error → respawn once, then NEEDS-HUMAN(reviewer-failed) |
| FIX | `SendMessage(builderAgentId, critical+important findings)`; if agent gone → fresh builder with brief+report+findings | `#status=fixing`; append Build Report | REVIEW (scoped: prev head..new head; reviewers mark each finding ADDRESSED/NOT_ADDRESSED + new breakage) |
| APPROVE | spawn **approver** (spec, report, full base..head package, 4 review JSONs, Standards) | `#status=approving`; Approval note | APPROVE → MERGE; ESCALATE → NEEDS-HUMAN(approver) |
| MERGE | `factory-merge <repo> <slug> "Merge <slug>: T-001 <title>"`; optional `#testCmd` smoke on main | `#status=merging` | ok → DONE; conflict → `blocked/merge-conflict`, SendMessage builder "rebase onto main, resolve, rerun tests", scoped code-review of the resolution, retry |
| DONE | graphify rebuild via git post-merge hook; `factory-event task --status done`; milestone done when all tasks done | `#status=done #mergedSha`; log | SELECT |
| NEEDS-HUMAN | report what is needed, stop the loop | `#status=needs-human #escalation`; `#wsStatus=paused` | `run approve T-001` → MERGE (Human Decision approve); `run reject T-001 "notes"` → Human Decision reject, `#round=0`, FIX with notes as findings |
| FINISH | all tasks done | `#wsStatus=done #stageExecute=done` | offer `factory-worktree remove` (branch kept) |

Reviewers run only while the builder is idle, so four parallel readers are safe. Minor findings are
recorded but never trigger CHANGES. Every Agent `description` includes `[task:<noteId>]` and the
run note gets `#agentId` so the dashboard can join live agents to cards.

## Agents (`agents/*.md`)

Common: explicit `model`; `tools` allowlists exclude MCP (nobody but the orchestrator touches Trilium);
reviewers `disallowedTools: Write, Edit, NotebookEdit, Agent`; builder `disallowedTools: Agent`.
Body ends with an output contract: ≤ 15 lines then exactly one fenced `json` block. Each body
includes the graphify paragraph from `agent-protocol.md`.

| Agent | Model | Tools | Inputs (paths) | JSON output |
|---|---|---|---|---|
| spec-writer | fable | Read, Glob, Grep, Bash (ro), Write(.factory/tasks/**) | brief.md, cached spec/plan/uiux/api, Standards | `{status: DONE\|NEEDS_CONTEXT, spec_path, open_questions[]}` |
| builder | opus | Read, Write, Edit, Glob, Grep, Bash | worktree path, spec.md, report.md, lint/test cmds, prior findings | `{status: DONE\|DONE_WITH_CONCERNS\|NEEDS_CONTEXT\|BLOCKED, commits[], tests{cmd,summary}, concerns[], report_path}` |
| security-reviewer | opus | Read, Glob, Grep, Bash (ro) | diff, spec, report, worktree, open findings | `{reviewer, verdict: PASS\|CHANGES, not_applicable, findings[{id,severity,file,line,summary,fix}], addressed[]}` |
| ux-reviewer | sonnet | same | + UI-UX Spec | same shape; `not_applicable: true` + PASS when no user-facing surface |
| ui-design-reviewer | sonnet | same | + UI-UX Spec, `.factory/mockups/` | same shape |
| code-reviewer | opus | same | + Standards, plan constraints | same shape; also spec compliance (missing/extra/misunderstood) |
| approver | opus | Read, Glob, Grep, Bash (ro) | spec, report, full package, 4 review JSONs, Standards | `{verdict: APPROVE\|ESCALATE, reasons[], risk, merge_notes}` |
| codebase-examiner | sonnet | Read, Glob, Grep, Bash (ro), Write(.factory/examine/**) | repo root, graphify report | `{report_path, languages[], frameworks[], maturity{lint,tests,ci,docs}, entrypoints[]}` |
| standards-researcher | sonnet | WebSearch, WebFetch, Read, Write(.factory/research/**) | examination or greenfield answers, questions | `{report_path, recommendations[{area,choice,version,why}]}` |
| plan-adversary | opus | Read, Glob, Grep, Bash (ro) | one lens, doc exports, task list, graph report | `{lens, verdict: PASS\|FAIL, findings[]}` |

Builder protocol mirrors superpowers' subagent-driven-development (brief file, report file, status
enum, max fix rounds, scoped re-review) — see
`~/.claude/plugins/cache/claude-plugins-official/superpowers/7.0.0/skills/subagent-driven-development/`.

## Hooks (`hooks/hooks.json`)

```json
{"hooks":{
 "SubagentStart":[{"hooks":[{"type":"command","command":"\"${CLAUDE_PLUGIN_ROOT}/bin/factory-event\" subagent-start","async":true,"timeout":5}]}],
 "SubagentStop": [{"hooks":[{"type":"command","command":"\"${CLAUDE_PLUGIN_ROOT}/bin/factory-event\" subagent-stop","async":true,"timeout":5}]}],
 "SessionStart": [{"matcher":"startup|clear|compact","hooks":[{"type":"command","command":"\"${CLAUDE_PLUGIN_ROOT}/bin/factory-event\" session-start","timeout":3}]}]
}}
```
`factory-event`: POSIX sh, exits 0 immediately unless `$CLAUDE_PROJECT_DIR/.factory/config.json`
exists; wraps stdin as `{event, ts, project: cwd, payload}`; `curl -s -m 2 --connect-timeout 1 … || true`.
`session-start` prints one context line ("factory project, active workstream X, N tasks need a human — run /factory:run")
when configured. No overlap with the user's existing Notification/Stop/UserPromptSubmit hooks.

## Stage notes (what each `stages/*.md` must contain)

- **setup**: idempotent checklist — global config (ask URL + token if missing; mode 600) → ETAPI
  `app-info` ≥ 0.106 and `/mcp` probe → `mcp__trilium__*` present (else `/mcp` reconnect) → `uv`
  (`curl -LsSf https://astral.sh/uv/install.sh | sh`) → `uv tool install graphifyy`
  → `graphify hook install` → bun (`curl -fsSL https://bun.sh/install | bash`) → superpowers present
  (else tell user `/plugin install superpowers`) → Trilium `#factoryRoot`/`#factoryProject`/Factory Log
  (find or create; cache ids) → `.factory/` + `.gitignore` entries → `bin/factory-dashboard start` →
  `stageSetup=done`. Tell the user what will be installed before installing.
- **examine**: greenfield/brownfield detection (`git log`, source files). Greenfield: dialogue on what we
  are building, `standards-researcher`-style web validation of the idea's dependencies, gap questions,
  Goal doc from template. Brownfield: spawn `codebase-examiner` (graph-first), present findings, ask the
  goal, Goal + Codebase Examination docs. Human approval of Goal.
- **set-standards**: spawn `standards-researcher` for current versions/tooling; dialogue per area
  (runtimes, API docs, CI, artifacts, pipelines, public docs, other traits); brownfield defaults to what
  exists with alternatives; Standards doc + machine labels (`#lintCmd` …); approval.
- **enforce-standards**: diff desired scaffolding vs repo → Enforcement Plan doc (`#approval=pending`) →
  AskUserQuestion approve/edit/skip → apply (Dependabot, workflows, Makefile, Containerfile, …) → run
  lint/test → commit on `main` → `#appliedSha`, `stageEnforce=done|skipped`.
- **brainstorm**: ask slug (≤ 63 chars, `[a-z0-9-]`) + overview → create workstream note + worktree/branch
  → invoke `superpowers:brainstorming` with the stated preference "write the design into Trilium
  (Workstreams/<slug>/Spec) via the orchestrator, no `docs/superpowers/` files; Goal and Standards are
  context" → after approval invoke `superpowers:writing-plans` the same way → Plan note `#planRev=1`;
  export both to `.factory/workstreams/<slug>/docs/`.
- **uiux**: decide applicability from the Plan (else `skipped`); brownfield UI inventory; questions on
  framework / UX per user story; when visual design is wanted write 2–3 HTML option mockups to
  `.factory/mockups/<slug>/` and open `/mockups/<slug>/` in the dashboard; UI-UX Spec doc.
- **api-design**: applicability; clarify parameters; write/update repo API docs per Standards (e.g.
  OpenAPI path from `#apiDocPath`); API Design doc.
- **plan**: milestones/tasks from Spec/Plan/UI-UX/API; each task has `#dependsOn`, acceptance
  criteria, files touched; if tasks exist: inspect `git log`, untracked files, repo state, realign and
  bump `#planRev`; approval.
- **validate**: spawn N `plan-adversary` instances in one message (lenses: feasibility, missing
  requirements, security, UX, sequencing/dependencies, standards compliance); write Validation/Round N
  with child notes; `pass` only if no FAIL; on fail present findings and loop back to `plan`.
- **execute**: the state machine above.
- **graph**: `graphify update .` whether `graphify-out/` is missing or present (CLI only, no LLM pass);
  ensure git hooks present (`graphify hook install`). Worktrees share `.git/hooks`, so builder commits
  refresh the graph too.

## Dashboard (`dashboard/`)

**Stack:** Bun ≥ 1.2.10, `Bun.serve({ routes })` with HTML imports (React 19 + TSX bundled on the fly;
`development: FACTORY_DEV=1`). Deps: `react`, `react-dom`, `marked`, `dompurify`; dev: `@types/{bun,react,react-dom}`.
No router, no CSS framework. Fallback if HTML imports misbehave: `bun build web/index.html --outdir dist`.

```
dashboard/
  package.json, tsconfig.json
  src/server.ts            entry: config, repo registry, Bun.serve routes
  src/daemon.ts            spawn server detached (own process group, log, pidfile) — used by bin/factory-dashboard
  src/config.ts            global config (+env overrides); token never reaches the browser
  src/repos.ts             repoPath → {projectNoteId, activeWorkstream, poller, agents}; reads <repo>/.factory/config.json
  src/hub.ts               EventHub: subscribe(repo)/publish(repo, event) → SSE clients
  src/trilium/client.ts    ETAPI: searchNotes(q,{ancestorNoteId,orderBy,limit}), getNote, getContent
  src/trilium/mapper.ts    pure: ETAPI Note[] → Project/Workstream/Milestone/Task/Doc/AgentRun/Review
  src/trilium/poller.ts    per-repo loop (3 s); fingerprint (noteId, utcDateModified, status, agent, round); publish on change only
  src/agents/registry.ts   LiveAgent map (50 recent, 30 min TTL)
  src/agents/transcript-path.ts   cwd → slug (non-[A-Za-z0-9] → '-'); glob fallback under ~/.claude/projects/*/*/subagents
  src/agents/parser.ts     pure: JSONL line → Step {seq, ts, kind: text|thinking|tool|result, tool{name,summary}, isError}
  src/agents/tailer.ts     offset reader, fs.watch + 500 ms poll, partial-line buffer, retry while file absent
  src/routes/{api,events,stream,mockups}.ts
  src/shared/{types,columns}.ts   shared with web
  web/index.html, main.tsx, app.tsx, styles.css, lib/{stream,store,render}.ts
  web/components/{DocsTabs,Kanban,TaskDrawer,Agents,Steps,Mockups}.tsx
  test/fixtures/{etapi/*.json, transcripts/agent-sample.jsonl+.meta.json}
  test/{mapper,parser,columns,poller,tailer}.test.ts, test/integration/{fake-etapi.ts,server.test.ts}
  scripts/{fake-etapi.ts, send-event.sh, verify.md}
```

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | `{ok,pid,uptimeSec,version,trilium:{ok,url},repos[]}` |
| `GET /api/repos`, `POST /api/repos {path}` | registered repos + workstreams |
| `GET /api/state?repo&ws` | `WorkstreamSnapshot` {project, workstream, milestones, tasks, docs, runs, live, fingerprint} |
| `GET /api/docs/:noteId` | content, `format: html|markdown`, ETag = utcDateModified → 304 |
| `GET /api/tasks/:noteId` | task + spec + reviews per round + approval + runs |
| `GET /api/agents?repo`, `GET /api/agents/:id/steps?after=seq` | live/recent agents; steps |
| `GET /api/stream?repo` | SSE `snapshot`, `agent {op:start|update|stop}`, `step`, `heartbeat` (15 s) |
| `POST /api/events` | hook/orchestrator ingest `{event, ts, project, payload}` → 204; auto-registers repo if `<cwd>/.factory/config.json` exists |
| `GET /mockups/:repoSlug/*` | static files from `<repo>/.factory/mockups/` (traversal guard) |

Reads per poll (no N+1): `#factoryProject` (every 10th poll), then `#factoryWorkstream`, `#factoryMilestone`,
`#factoryTask`, `#factoryAgentRun` (orderBy utcDateModified desc, limit 200), `#factoryDoc`, `#factoryReview`,
each with `ancestorNoteId`. Content lazily, cached by `utcDateModified`. Fallback `… AND note.ancestors.noteId='X'`.

Columns (`shared/columns.ts`): todo→Backlog, spec→Spec Writer, building|fixing→Builder,
reviewing→Reviewers (four chips from the round's Review verdicts: pending/running/pass/changes),
approving|merging→Approver, needs-human|blocked→Needs Human (blocked badge), done→Done.
Cards: title, milestone, agent + model, round, elapsed ticker, live pulse. Drawer: spec, reviews,
approval, steps. Tabs: Board | Goal | Standards | Overview | Spec | Plan | UI/UX | API | Validation | Agents | Mockups.
Live agent ↔ task join via `[task:<noteId>]` in the Agent description (meta.json) or `#agentId` on the run note.

Daemon: `bin/factory-dashboard start|stop|status|open` → `bun dashboard/src/daemon.ts` spawns the server
`detached: true` + `unref()`; pidfile + log under `~/.config/claude-factory/`; health loop ≤ 10 s; idempotent.

## Implementation order

Each milestone ends with a runnable check. Milestones 2–6 and 7 are independent and can proceed in parallel.

1. **Plugin skeleton + bin scripts.** `git init`, `plugin.json`, `.gitignore`, README stub,
   `hooks/hooks.json`, all `bin/*` scripts, `tests/bin/*.test.ts` (temp git repo; stub `curl`/`npx` on PATH).
   Check: `claude plugin validate . --strict`; `bun test tests/`; `claude --plugin-dir .` shows the plugin.
2. **Orchestrator core.** `skills/run/SKILL.md`, `references/*`, `templates/*`, the 11 alias skills,
   `stages/setup.md`, `stages/graph.md`. Check: load with `--plugin-dir`, `/mcp` shows `trilium` with its
   tools, `/factory:setup` completes against the real Trilium and creates `ClaudeProjects/<repo>`.
3. **Agents.** Ten `agents/*.md` with contracts. Check: spawn each once in a throwaway session; verify
   `.meta.json` model matches frontmatter (catches `CLAUDE_CODE_SUBAGENT_MODEL` override); JSON block parses.
4. **Stages examine, set-standards, enforce-standards.** Check: throwaway greenfield repo → Goal, Standards
   (with `#lintCmd`…), Enforcement Plan approved and applied, commit on main.
5. **Stages brainstorm, uiux, api-design, plan, validate.** Check: Spec/Plan land in Trilium and
   `.factory/workstreams/<slug>/docs/`, no `docs/superpowers/` files; tasks with `#dependsOn`; Validation pass.
6. **Stage execute + approve/reject/status.** Check: one task end to end (Task Spec, 4 Review R1 notes,
   Approval, `#status=done`, `#mergedSha == git log -1 main`, `--no-ff` merge, graph refreshed); force an
   escalation and `reject` → builder resumed with notes; `/clear` then `/factory:run status` resumes.
7. **Dashboard.** First a single static HTML mockup of Board + tabs for the user's reaction, then the
   dashboard steps: types/columns → trilium client/mapper → parser → config/repos/hub/poller → server + fake
   ETAPI integration test → events/registry/tailer → SSE → web (Kanban, DocsTabs, TaskDrawer, Agents, Steps)
   → mockups route → daemon. Check: `bun test dashboard/`; `scripts/verify.md` manual checklist.
8. **End-to-end smoke + docs.** Full pipeline on a throwaway "hello CLI" repo with the dashboard open; write
   `docs/superpowers/specs/2026-11-10-factory-plugin-design.md` and README (install, naming, first run,
   Trilium MCP enablement, pinned superpowers 7.0.0). Commit.

## Verification

- `claude plugin validate /Users/kemo/Development/claude-sf --strict`; `claude plugin details factory`
  (keep orchestrator + references under ~8k tokens).
- `bun test` (bin scripts, dashboard units, dashboard integration against the fake ETAPI).
- `claude --plugin-dir /Users/kemo/Development/claude-sf`: `/help` lists `/factory:*`; `/mcp` shows `trilium`
  connected; Agent tool lists the ten agents.
- Smoke run (milestone 8 checklist) against the real Trilium; confirm the dashboard received
  subagent-start/stop events and the card drawer shows live steps.

## Risks to check during the build

- Bare `/factory` resolution and the `allowed-tools: mcp__trilium` server-wide rule (fallback: list tools).
- `fable` availability for subagents and the per-agent `model:` override vs `CLAUDE_CODE_SUBAGENT_MODEL`.
- Markdown fidelity through the Trilium MCP conversion (tables, fenced code); fallback `code`/`text/x-markdown`
  for Spec/Plan only.
- `search_notes` honouring `orderBy/limit`; ETAPI `ancestorNoteId` honoured (fallback in query string).
- Trilium MCP is registered natively by setup (`claude mcp add --scope user --transport http trilium <url>/mcp --header "Authorization: Bearer <token>"`); the server only connects after `/mcp` reconnect or restart (first run says so and stops).
- Graphify crawling `.factory/worktrees/` (verify it honours `.gitignore`; else exclude).
- Bun HTML-import bundling stability (pin Bun; `bun build` fallback).
- Branch `<slug>` colliding with an existing branch (`factory-worktree ensure` refuses foreign branches).

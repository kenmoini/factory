# factory — Claude Software Factory plugin

A Claude Code plugin that turns a git repo into a Claude-driven software factory. Trilium holds all knowledge, planning and tracking; Graphify keeps a code graph of the repo; `/factory:run` is the single entry point and orchestrates the stage pipeline (setup, examine, set-standards, enforce-standards, brainstorm, UI/UX, API design, plan, validate, execute). The session that runs it is the orchestrator: it spawns every subagent and is the only writer of Trilium. A local web dashboard (separate plan) will show workstream documents and a Kanban board.

Design: `docs/superpowers/specs/2026-11-10-factory-plugin-design.md`.

## Requirements

- Claude Code 2.1.x or later, with plugin support.
- A TriliumNext instance 0.106 or later, with the MCP server enabled under Options -> AI/LLM -> MCP server, and an ETAPI token (Options -> ETAPI -> Create new ETAPI token).
- git.
- The `superpowers` plugin from `claude-plugins-official` (`/plugin install superpowers@claude-plugins-official`).
- bun, uv and graphify: setup installs them on your confirmation.

## Install

Development, from a checkout:

```
claude --plugin-dir /path/to/claude-sf
```

From a marketplace (placeholders are literal; fill in your own):

```
/plugin marketplace add <owner>/<repo>
/plugin install factory@<marketplace-name>
```

`claude plugin validate` advises this line for a marketplace install (works in one step on Claude Code 2.1.275 or later):

`/plugin install factory --marketplace <owner>/<repo>`

## First run

1. In the repo you want to work on, run `/factory:run`.
2. Setup walks through the config: Trilium URL and ETAPI token (stored in the global factory config, mode 600), tool installs, git, working files and the Trilium project notes. Each change is confirmed first.
3. Setup registers the Trilium MCP server natively: `claude mcp add --scope user --transport http trilium <url>/mcp --header "Authorization: Bearer <token>"`.
4. Run `/mcp` and reconnect (or restart Claude Code), then run `/factory:run` again. The MCP tools are only available after that.

## Commands

`/factory:run [status|approve <task>|reject <task> "notes"|<stage>] [--workstream <slug>]`

| Argument | Purpose |
|---|---|
| (none) | Continue the pipeline from the next unfinished stage |
| `status` | Show project, workstream and task status |
| `approve <task>` | Approve an escalated (`needs-human`) task so it merges (for example `T-001`) |
| `reject <task> "notes"` | Reject an escalated task with reasons; the notes go back to the builder |
| `<stage>` | Run one stage (verifies prior stages first) |
| `--workstream <slug>` | Use this workstream instead of the active one |

Stage commands (each also available as `/factory:run <stage>`):

| Command | Purpose |
|---|---|
| `/factory:setup` | Trilium config and MCP, tools, project note and Factory Log |
| `/factory:examine` | Greenfield new-project flow or brownfield codebase examination; writes the Goal |
| `/factory:set-standards` | Research and agree the project standards (lint/test/build/CI) |
| `/factory:enforce-standards` | Enforcement plan, user approval, scaffold |
| `/factory:brainstorm` | Brainstorm a workstream: slug and overview, then brainstorming and writing-plans into Trilium |
| `/factory:uiux` | UI-UX spec and mockups served by the dashboard, if the plan calls for it |
| `/factory:api-design` | Contracts and repo API docs, if contracts exist |
| `/factory:plan` | Milestones and tasks; realign if they exist |
| `/factory:validate` | Adversarial reviews of the plan |
| `/factory:execute` | Spec, build, 4 reviews, approve, merge, task by task |
| `/factory:graph` | Build or update the Graphify code graph |

## How it works

- Stages run in order; each checks that the prior stages' labels exist in Trilium.
- Trilium is the source of truth, under `ClaudeProjects/<repo>` (project note, Factory Log, workstream documents, milestones, tasks).
- Each workstream gets one git worktree and branch named by its slug, at `.factory/worktrees/<slug>`.
- Execute works one task at a time: spec, build, four parallel reviews, approve, then a local `--no-ff` merge to the default branch (`main`, else `master`).
- There is no per-task human gate: once the four reviews pass, the approver agent approves and the task merges automatically. You decide only escalated tasks (`needs-human`: fix-round cap reached, approver escalation, builder, spec-writer or reviewer failure, unresolved merge conflict) with `/factory:run approve <task>` or `/factory:run reject <task> "notes"`. The documents (Goal, Standards, Enforcement Plan, Spec, Plan, UI-UX Spec, API Design) are approved by you in the session as each stage asks.
- Builders run lint and tests in the worktree; re-running the tests on the default branch after each merge is opt-in (Standards label `#postMergeSmoke=true`).
- The orchestrator never edits product code; builders do, in worktrees.

## Working files

Created in the target repo by setup and gitignored (`.factory/` and `graphify-out/` are added to `.gitignore`):

```
.factory/
  config.json     repo config (cached project note id, active workstream)
  state.json      execute ledger (Trilium wins when they disagree)
  docs/           exports of the project documents for agents
  examine/        examine drafts and codebase-examiner output
  research/       standards research questions, answers, report and Standards draft
  enforce/        enforcement plan file drafts, lint/test logs, applied.txt
  worktrees/      one git worktree per workstream
  mockups/        UI mockups
  tasks/          task working files
  workstreams/    workstream working files
```

The global config (Trilium URL, token, dashboard port) lives outside the repo; read it with `factory-config`.

## Dashboard

Today only a static mockup exists: `dashboard/mockup/board.html`. The live dashboard is a separate plan. Until it is built, `factory-dashboard status` reports "not built" and setup mentions that once and continues.

## Known caveats

- `fable` model availability for the spec-writer falls back per Claude Code's rules. Verify in a smoke run via the subagent `.meta.json`.
- `CLAUDE_CODE_SUBAGENT_MODEL` in user settings can override per-agent `model:`. Verify in a smoke run.
- The Trilium MCP server connects only after `/mcp` reconnect or a restart.
- `claude plugin validate` warns about a missing plugin icon.
- superpowers is pinned and tested at 7.0.0.

## Development

```
bun install
bun test
claude plugin validate . --strict
```

- Specs and plans live in `docs/superpowers/` (`specs/`, `plans/`).
- `tests/plugin/content.test.ts` is the content harness: it gates every skill, agent and stage file.
- Command-line tools are in `bin/` (`factory-config`, `factory-event`, `factory-preflight`, `factory-worktree`, `factory-review-package`, `factory-merge`, `factory-dashboard`).

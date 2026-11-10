# factory — Claude Software Factory plugin

A Claude Code plugin that turns a git repo into a Claude-driven software factory. Trilium holds all knowledge, planning and tracking; Graphify keeps a code graph of the repo; `/factory:run` is the single entry point and orchestrates the stage pipeline (setup, examine, set-standards, enforce-standards, brainstorm, UI/UX, API design, plan, validate, execute). The session that runs it is the orchestrator: it spawns every subagent and is the only writer of Trilium. A local web dashboard (separate plan) will show workstream documents and a Kanban board.

Design: `docs/superpowers/specs/2026-11-10-factory-plugin-design.md`.

## Requirements

- Claude Code 2.1.x or later, with plugin support.
- A TriliumNext instance 0.106 or later, with the MCP server enabled under Options -> AI/LLM -> MCP server, and an ETAPI token (Options -> ETAPI -> Create new ETAPI token). You paste the token into the project's `.mcp.json` yourself; the factory never asks for it.
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
2. If no `trilium` MCP server is configured yet, setup asks only for the Trilium base URL and writes the project-scope `<repo>/.mcp.json` (mode 600, added to `.gitignore`, other servers kept) with a placeholder token:

   ```json
   { "mcpServers": { "trilium": { "type": "http", "url": "<triliumBaseUrl>/mcp", "headers": { "Authorization": "Bearer your-etapi-token" } } } }
   ```

   For an `https://` Trilium it also offers to write `NODE_TLS_REJECT_UNAUTHORIZED=0` into `<repo>/.claude/settings.local.json` (`env`), so Claude Code's own MCP client accepts a self-signed certificate. Then it stops.
3. Open `<repo>/.mcp.json`, replace `your-etapi-token` with your ETAPI token (Options -> ETAPI in Trilium), run `/mcp` and reconnect (or restart Claude Code; approve the project server `trilium` if asked), then run `/factory:run` again. The token never passes through Claude.
4. Setup then checks Trilium (version, MCP endpoint), installs tools, prepares git and the working files and creates the Trilium project notes. Each change is confirmed first.

An existing `trilium` server in user scope (`~/.claude.json`) is used when the project has none. Upgrading from a version that kept the URL and token in `~/.config/claude-factory/config.json`: setup offers to move them, or run `factory-config migrate-trilium --repo <repo>` yourself (it writes `<repo>/.mcp.json`, gitignores it, deletes the two keys from the global config and never prints the token).

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

Created in the target repo by setup and gitignored (`.factory/`, `graphify-out/` and `.mcp.json` are added to `.gitignore`):

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

Trilium URL and token live in the project `.mcp.json` (gitignored). The global config (`~/.config/claude-factory/config.json`) holds only the dashboard port; read it with `factory-config`.

## Dashboard

A local web app (Bun, under `dashboard/`) shows each factory repo's workstream: the Kanban board with live agents, the documents, validation rounds, agent transcripts and mockups. It reads Trilium over ETAPI and gets hook events from `factory-event`.

- `factory-dashboard start [--port N] [--open]` starts it in the background (default port 7777, or `dashboardPort` in the global config) and registers the repo it is run from. On first run it installs the dashboard's dependencies (`bun install --frozen-lockfile` in `dashboard/`, output in `dashboard.log`).
- `factory-dashboard status | open | stop | restart`. The pidfile and `dashboard.log` live in the global config directory.
- Trilium URL and ETAPI token are per repo, read from the Trilium MCP server Claude Code uses: `mcpServers.trilium` in `<repo>/.mcp.json` (`url` `<trilium>/mcp`, `headers.Authorization` `Bearer <token>`), else in `~/.claude.json` (user scope). `${VAR}` references in it are expanded from the dashboard's environment, as Claude Code does; `FACTORY_TRILIUM_URL` / `FACTORY_ETAPI_TOKEN` override both. Changes are picked up without a restart. A placeholder token (`your-etapi-token`, or empty) keeps the repo listed but not polled: its board answers `trilium token not configured` until the real token is in place. `/api/repos` shows each repo's Trilium URL and where it came from, never the token.
- TLS certificates are not verified (a self-signed Trilium works); set `FACTORY_TLS_VERIFY=1` before `factory-dashboard start` to verify them.
- It listens on 127.0.0.1 only, answers only requests addressed to `127.0.0.1`, `localhost` or `[::1]` on its port, accepts POSTs only as `application/json`, and serves only the Trilium notes the factory shows.

## Known caveats

- `fable` model availability for the spec-writer falls back per Claude Code's rules. Verify in a smoke run via the subagent `.meta.json`.
- `CLAUDE_CODE_SUBAGENT_MODEL` in user settings can override per-agent `model:`. Verify in a smoke run.
- The Trilium MCP server connects only after `/mcp` reconnect or a restart; Claude Code asks you to approve a new project `.mcp.json` server.
- TLS: the plugin's own Trilium calls (preflight, setup checks) skip certificate verification by default, for self-signed certificates; set `FACTORY_TLS_VERIFY=1` to verify. Claude Code's MCP client verifies certificates unless `NODE_TLS_REJECT_UNAUTHORIZED=0` is in `<repo>/.claude/settings.local.json` `env` (setup offers it; it applies after a restart and turns verification off for everything Claude Code starts in that project).
- Keep `.mcp.json` out of git: setup and `migrate-trilium` do not write to a `.mcp.json` that git tracks (the token would be committed) until it is untracked (`git rm --cached .mcp.json`; setup offers this).
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

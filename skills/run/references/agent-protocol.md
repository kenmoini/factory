# Agent protocol

How the orchestrator dispatches the ten `factory:*` agents, what each must return, and how results are
parsed. Agent files (`agents/*.md`) copy their contract and the graphify paragraph from here.

## Dispatch

- Agent tool call: `subagent_type: "factory:<agent>"`, `description`, `prompt` = the brief below. Foreground
  unless the stage says otherwise. Parallel work (four reviewers, six adversaries) = several Agent calls in ONE
  assistant message; wait for all results before acting.
- `description`: `<agent> <taskId|stage>[ R<n>] [task:<noteId>]`, e.g. `security-reviewer T-001 R2 [task:aB3xY9]`,
  `codebase-examiner examine [task:none]`. `<noteId>` is the Trilium task note id; `[task:none]` when no task.
- Around every dispatch: Agent Run note before, rename/labels after (convention in `trilium-schema.md`).
- Follow-ups go to the same agent with `SendMessage(to: <agentId>, message: …)`; the message starts with
  `[task:<noteId>]` and ends with `Return the same contract.`
- Path shorthands below are expanded to absolute paths in the brief: `<repoPath>` absolute repo root;
  `<wt>` = `<repoPath>/.factory/worktrees/<slug>`; `<docs>` = `<repoPath>/.factory/workstreams/<slug>/docs`;
  `<taskDir>` = `<repoPath>/.factory/tasks/<slug>/<taskId>`; `$PLUGIN_ROOT` = the plugin root given in SKILL.md.

## Brief format (exact)

```
Task: <one line> [task:<noteId>]
Read first: <path>
Inputs: <paths>
Write: <paths>
Return: ≤15 lines then exactly one fenced json block matching your contract
```

- Exactly these five lines, in this order, nothing before or after. `[task:none]` when no task is involved.
- All paths absolute. `Inputs:` is a comma-separated list of `name=value`; values are paths, scalars
  (`round=2`, `lens=security`, `branch=auth-login`) or commands in backticks (`` test=`bun test` ``); an input
  that does not exist is passed as `name=none`.
- `Write:` lists the only paths (globs allowed) the agent may create or modify; `none` for read-only agents.
- Never paste document bodies; anything longer than one line goes into a file under `<taskDir>` or `.factory/`.

| Agent (`factory:`) | Read first | Inputs | Write |
|---|---|---|---|
| `spec-writer` | `<taskDir>/brief.md` | `docs=<docs>/`, `standards=<docs>/standards.md`, `template=$PLUGIN_ROOT/skills/run/templates/task-spec.md` | `<taskDir>/spec.md` |
| `builder` | `<taskDir>/spec.md` | `worktree=<wt>`, `branch=<slug>`, `report=<taskDir>/report.md`, `` lint=`<lintCmd>` ``, `` test=`<testCmd>` ``, `` build=`<buildCmd>` ``, `findings=<taskDir>/findings-R<n>.md` (fix only) | `<wt>/**`, `<taskDir>/report.md` |
| `security-reviewer` | `<taskDir>/review-R<n>.diff` | `spec=<taskDir>/spec.md`, `report=<taskDir>/report.md`, `worktree=<wt>`, `round=<n>`, `open=<taskDir>/open-findings-R<n-1>.json` (round > 1) | none |
| `ux-reviewer` | same | same + `uiux=<docs>/uiux.md` | none |
| `ui-design-reviewer` | same | same + `uiux=<docs>/uiux.md`, `mockups=<repoPath>/.factory/mockups/<slug>/` | none |
| `code-reviewer` | same | same + `standards=<docs>/standards.md`, `plan=<docs>/plan.md` | none |
| `approver` | `<taskDir>/spec.md` | `report=<taskDir>/report.md`, `package=<taskDir>/approval.diff`, `reviews=<taskDir>/reviews-R<n>.json`, `standards=<docs>/standards.md` | none |
| `codebase-examiner` | `<repoPath>/graphify-out/GRAPH_REPORT.md` (or `<repoPath>` when absent) | `repo=<repoPath>` | `<repoPath>/.factory/examine/**` |
| `standards-researcher` | `<repoPath>/.factory/research/questions.md` | `examination=<repoPath>/.factory/examine/report.md` (brownfield) or `answers=<repoPath>/.factory/research/answers.md` (greenfield) | `<repoPath>/.factory/research/**` |
| `plan-adversary` | `<repoPath>/.factory/workstreams/<slug>/tasks.md` | `lens=<lens>`, `docs=<docs>/`, `graph=<repoPath>/graphify-out/GRAPH_REPORT.md` | none |

Example (builder):

```
Task: Implement T-001 Login form validation in the worktree [task:aB3xY9]
Read first: /src/app/.factory/tasks/auth-login/T-001/spec.md
Inputs: worktree=/src/app/.factory/worktrees/auth-login, branch=auth-login, report=/src/app/.factory/tasks/auth-login/T-001/report.md, lint=`bun run lint`, test=`bun test`, build=none
Write: /src/app/.factory/worktrees/auth-login/**, /src/app/.factory/tasks/auth-login/T-001/report.md
Return: ≤15 lines then exactly one fenced json block matching your contract
```

## JSON contracts

Every agent ends its final message with ≤ 15 lines of prose then exactly one fenced `json` block in these
shapes. Enum values are exact (upper/lower case as shown). Paths are absolute.

**spec-writer** — `status`: `DONE` | `NEEDS_CONTEXT` (then `open_questions` non-empty).

```json
{"status": "DONE", "spec_path": "/src/app/.factory/tasks/auth-login/T-001/spec.md", "open_questions": []}
```

**builder** — `status`: `DONE` | `DONE_WITH_CONCERNS` | `NEEDS_CONTEXT` | `BLOCKED`. `commits`: `<short sha> <subject>`
made in this run, oldest first. `concerns` carries the concerns, the questions (NEEDS_CONTEXT) or the blocker (BLOCKED).

```json
{"status": "DONE", "commits": ["3f2a9c1 feat(auth): validate login form"], "tests": {"cmd": "bun test", "summary": "48 pass, 0 fail"}, "concerns": [], "report_path": "/src/app/.factory/tasks/auth-login/T-001/report.md"}
```

**security-reviewer, ux-reviewer, ui-design-reviewer, code-reviewer** — one shared shape.
`reviewer`: `security` | `ux` | `ui-design` | `code`. `verdict`: `PASS` | `CHANGES`. `severity`: `critical` (security
hole, data loss, or spec violation that ships broken behaviour) | `important` (bug or standards breach a user would hit)
| `minor` (style, nit: recorded, never causes CHANGES). `verdict` is `CHANGES` iff a `critical`/`important` finding
exists or an `addressed[]` item is `NOT_ADDRESSED`. Finding ids `<PREFIX>-R<round>-<n>` with prefix `SEC`, `UX`, `UID`,
`CODE`. `line` is an integer or `null`. `addressed[]` is filled only when `open=` is given: one item per open finding of
this reviewer, `status` `ADDRESSED` | `NOT_ADDRESSED`. `ux-reviewer` and `ui-design-reviewer` return
`not_applicable: true`, `verdict: PASS`, empty arrays when the diff has no user-facing surface. `code-reviewer` also
checks spec compliance; such findings start their `summary` with `spec missing:`, `spec extra:` or `spec misunderstood:`.

```json
{"reviewer": "security", "verdict": "CHANGES", "not_applicable": false, "findings": [{"id": "SEC-R1-1", "severity": "important", "file": "src/auth/session.ts", "line": 42, "summary": "Session token written to the info log", "fix": "Drop the token from the log call"}], "addressed": []}
```

```json
{"reviewer": "code", "verdict": "PASS", "not_applicable": false, "findings": [], "addressed": [{"id": "CODE-R1-2", "status": "ADDRESSED", "note": "null guard added in src/parse.ts:17"}]}
```

```json
{"reviewer": "ux", "verdict": "PASS", "not_applicable": true, "findings": [], "addressed": []}
```

```json
{"reviewer": "ui-design", "verdict": "CHANGES", "not_applicable": false, "findings": [{"id": "UID-R1-1", "severity": "important", "file": "web/LoginForm.tsx", "line": 12, "summary": "Submit button uses an ad-hoc colour instead of the accent token from the chosen mockup", "fix": "Use var(--accent)"}], "addressed": []}
```

**approver** — `verdict`: `APPROVE` | `ESCALATE`; `risk`: `low` | `medium` | `high`; on `ESCALATE`, `reasons` state what a
human must decide.

```json
{"verdict": "APPROVE", "reasons": ["All acceptance criteria covered by tests", "Four reviews PASS"], "risk": "low", "merge_notes": "Adds migration 0007; run before deploy"}
```

**codebase-examiner** — `maturity` values: `none` | `partial` | `solid`.

```json
{"report_path": "/src/app/.factory/examine/report.md", "languages": ["TypeScript"], "frameworks": ["React 19", "Express 5"], "maturity": {"lint": "partial", "tests": "solid", "ci": "none", "docs": "partial"}, "entrypoints": ["src/server.ts", "web/main.tsx"]}
```

**standards-researcher** — one recommendation per area (e.g. `runtime`, `lint`, `test`, `build`, `api-docs`, `ci`,
`artifacts`, `pipelines`, `public-docs`, `other`); `version` is the current stable version verified on the web, or `""`.

```json
{"report_path": "/src/app/.factory/research/report.md", "recommendations": [{"area": "runtime", "choice": "Bun", "version": "1.3.2", "why": "Already used by the scripts; native TS test runner"}]}
```

**plan-adversary** — `lens`: `feasibility` | `missing-requirements` | `security` | `ux` | `sequencing` | `standards`;
`verdict`: `PASS` | `FAIL` (`FAIL` iff a `critical`/`important` finding); finding `task` is a task id or `plan`.

```json
{"lens": "sequencing", "verdict": "FAIL", "findings": [{"id": "sequencing-1", "severity": "important", "task": "T-004", "summary": "T-004 reads the sessions table created in T-006", "fix": "Make T-004 depend on T-006"}]}
```

## Parsing rule

1. Rule: take the LAST fenced ```json block of the agent's final message; if none parses, treat as BLOCKED with
   the message as reason. An Agent tool error (exception, max turns, killed) is handled the same way.
2. Validate: required keys present, enum values exact. A block that fails validation counts as "none parses".
3. Reviewers: recompute `verdict` from the rule above; if it differs from the agent's, use the recomputed one and
   note it in the Review note.
4. BLOCKED handling: spec-writer and builder → `execute-loop.md`; a reviewer → respawn that reviewer once, then
   NEEDS-HUMAN(`reviewer-failed`); approver → respawn once, then NEEDS-HUMAN(`approver`); codebase-examiner,
   standards-researcher, plan-adversary → respawn once, then report to the user and stop the stage.
5. Write the parsed JSON to a file when later steps need it (`<taskDir>/review-R<n>-<reviewer>.json`, etc.) and
   append the ≤ 15 lines + json block to the Agent Run note.

## Guardrails (every agent)

- No Trilium and no MCP tools: work only from the files in the brief; never ask for Trilium access.
- No user dialogue: you cannot ask the user anything. Return `NEEDS_CONTEXT` (spec-writer, builder) or state the
  assumption you made in your summary.
- Write only the paths in `Write:`; read-only agents create no files at all (not even scratch files in the repo).
- Git: only the builder writes git state, and only on branch `<slug>` inside the worktree, with conventional commit
  messages. Nobody checks out, merges into, rebases, resets or pushes `main`; no `git push`, no `--force`, no `git clean`.
- Bash for read-only agents means commands that change no file, no git state, no packages and no network
  (`git log|diff|show|status`, `ls`, `cat`, `graphify query|explain|path`).
- Dependencies: only the builder may add or install dependencies, and only those the task spec or Standards name,
  with the project's package manager inside the worktree; no global installs. Network: the builder only for that
  package-manager install, the standards-researcher only through WebSearch/WebFetch, everyone else none.
- Secrets: never read or print `~/.config/claude-factory/config.json`, `.env*` values or tokens; redact them in reports.
- No subagents. Do not claim tests or lint pass without running them; prefer `DONE_WITH_CONCERNS` to hiding a problem.
- Final message: ≤ 15 lines, then exactly one fenced json block, and nothing after it.

## Graphify paragraph (copy into every agent)

When `graphify-out/GRAPH_REPORT.md` exists at the root of the tree you work in (the worktree or repo path from your brief), read it first: it maps the modules, hubs and entry points. Prefer `graphify query "<question>"`, `graphify explain "<symbol>"` and `graphify path "<a>" "<b>"` over blind grep to find where code lives and how it connects, then open only the files they point to. Fall back to Grep and Glob when `graphify-out/` is absent, when the `graphify` command fails or is not available to you, or when the graph is stale (its answers name files or symbols that no longer exist, or miss ones you can see). Say in your final message whether you used the graph or fell back. Never rebuild the graph yourself; the orchestrator and git hooks keep it fresh.

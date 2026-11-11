# Stage: graph

Builds or refreshes the Graphify code graph of `<repoPath>` (`<repoPath>/graphify-out/graph.json`,
`GRAPH_REPORT.md`, `graph.html`) and keeps the git hooks that refresh it after every commit, checkout and merge.
On demand, outside the stage sequence: `/factory:graph`, `/factory:run graph`, or SOP 5 (`graphify-out/` missing).
Run every `graphify` command from `<repoPath>` (`cd "<repoPath>" && graphify …`).

## Prerequisites

1. `mcp__trilium__get_attributes(<projectNoteId>)` (`factory.projectNoteId`) shows `#stageSetup=done`. Else refuse
   `Missing #stageSetup=done on project <repoName>: run /factory:setup first.` and stop.
2. Preflight `graphify.installed=true`. Else refuse `Graphify is not installed: run /factory:setup (it installs it
   after asking).` and stop.

## Procedure

1. **Build or update** (CLI only: the factory never invokes the user-level `graphify` skill, whose semantic pass
   dispatches extraction subagents over docs and images and spends tokens the code graph does not need). Mode =
   `full build` when `graphify-out/graph.json` is missing before this step (preflight `graphify.outPresent=false`;
   confirm with `test -s`), else `update`. Run `cd "<repoPath>" && graphify update .` (Bash timeout 600000): AST
   extraction of code plus Markdown headings, no LLM. Ignore its closing tip about `/graphify --update`. Output
   `No code files found` → Stopped (`no code to graph`). It refuses because the rebuild has fewer nodes →
   `cd "<repoPath>" && graphify update . --force` (files were deleted). Any other non-zero exit → show the last 20
   lines; Stopped (`graph update failed`).
2. **Verify output.** `test -s "<repoPath>/graphify-out/graph.json" && test -s "<repoPath>/graphify-out/GRAPH_REPORT.md"`;
   fails → Stopped (`graph build produced no output`).
   - `git -C "<repoPath>" check-ignore -q graphify-out/graph.json` fails → append `graphify-out/` to
     `<repoPath>/.gitignore` (as in setup step 7; no commit) so graph files never reach a commit.
   - `grep -q '\.factory/worktrees/' "<repoPath>/graphify-out/graph.json"` succeeds → the graph indexed worktree
     copies. Tell the user once and log `- <ISO ts> [graph] warning: graph includes .factory/worktrees/`; continue.
3. **Git hooks.** `<hooksDir>` = output of `git -C "<repoPath>" rev-parse --path-format=absolute --git-path hooks`
   (right for linked worktrees, submodules and `core.hooksPath`). Present = `cd "<repoPath>" && graphify hook status`
   reports them installed, or `grep -q graphify "<hooksDir>/post-commit"` (not preflight `graphify.gitHooks`).
   - Missing → tell the user one line and run `cd "<repoPath>" && graphify hook install` (setup already had the
     user's consent; SOP 5 re-installs when missing); re-check as above.
   - Still absent (e.g. husky owns `core.hooksPath`) → warn once that the graph refreshes only through SOP 5's stale
     check, record hooks `bypassed`, and continue: hooks never stop this stage.
   - `hook install` also writes `graphify-out/graph.json merge=graphify` into `<repoPath>/.gitattributes`; left
     uncommitted it makes `factory-merge` report `dirty`. After an install, or whenever
     `git -C "<repoPath>" status --porcelain -- .gitattributes` is non-empty, run SOP 4's working-files commit (it
     checks the branch and skips a file with other uncommitted lines; then tell the user).
   - Worktrees share `<hooksDir>`, so commits by builders in `.factory/worktrees/<slug>` (and merges into
     `main`) refresh the graph too; never install hooks per worktree.

**Stopped** (any stop above): `- <ISO ts> [graph] stage stopped — <reason>` via `mcp__trilium__append_to_note` on
`Factory Log`; `factory-event stage --stage graph --status stopped </dev/null`; leave `#stageGraph` unchanged.

## Completion

1. `mcp__trilium__set_attribute(<projectNoteId>, stageGraph=done)`.
2. `mcp__trilium__append_to_note(<Factory Log>, "- <ISO ts> [graph] stage done — <full build|update>, hooks
   <present|installed|bypassed>")`; `Factory Log` is the child of the project note with that exact title
   (`mcp__trilium__get_child_notes(<projectNoteId>)`).
3. `factory-event stage --stage graph --status done </dev/null`.
4. Print one line: mode, `<repoPath>/graphify-out/GRAPH_REPORT.md`, hook state.

## Direct-command behaviour

Always re-runs, whichever way it is entered: the stage is idempotent, so `#stageGraph=done` never skips it and no
"run again?" question is asked. Entered via `/factory:graph` or `/factory:run graph` → stop after Completion.
Entered from SOP 5 inside another stage → return to that stage's step once Completion is done.

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

1. **Build or update.** Check `test -s "<repoPath>/graphify-out/graph.json"` (preflight `graphify.outPresent`).
   - Missing → full build (LLM-assisted, may take minutes): tell the user one line, then invoke the Skill tool with
     skill `graphify` and args `.` (the `/graphify .` build; if `pwd` is not `<repoPath>`, pass `<repoPath>` instead
     of `.`). Follow the skill's instructions to the end; continue only when `graph.json` exists.
     No `graphify` skill in your available skills list → tell the user it loads after `graphify install` and a
     Claude Code restart (setup step 5 runs `graphify install`); stop the stage (see Stopped below).
   - Present → `cd "<repoPath>" && graphify update .` (incremental, code only, no LLM). Non-zero exit → show the last
     20 lines; AskUserQuestion `Full rebuild with the graphify skill / Stop`; full rebuild = the Missing branch.
2. **Verify output.** `test -s "<repoPath>/graphify-out/graph.json" && test -s "<repoPath>/graphify-out/GRAPH_REPORT.md"`;
   fails → Stopped (`graph build produced no output`).
   - `git -C "<repoPath>" check-ignore -q graphify-out/graph.json` fails → append `graphify-out/` to
     `<repoPath>/.gitignore` (as in setup step 7; no commit) so graph files never reach a commit.
   - `grep -q '\.factory/worktrees/' "<repoPath>/graphify-out/graph.json"` succeeds → the graph indexed worktree
     copies. Tell the user once and log `- <ISO ts> [graph] warning: graph includes .factory/worktrees/`; continue.
3. **Git hooks.** Check `cd "<repoPath>" && graphify hook status` reports the hooks installed (if this Graphify has
   no `hook status`: `grep -q graphify "<repoPath>/.git/hooks/post-commit"`, the preflight `graphify.gitHooks` probe).
   - Missing → tell the user one line and run `cd "<repoPath>" && graphify hook install` (setup already had the
     user's consent; SOP 5 re-installs when missing); re-check as above.
   - `git -C "<repoPath>" config --get core.hooksPath` non-empty → warn once that `.git/hooks` is bypassed, so the
     graph refreshes only through SOP 5's stale check.
   - Worktrees share `<repoPath>/.git/hooks`, so commits by builders in `.factory/worktrees/<slug>` (and merges into
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

# Stage: examine

Decides whether `<repoPath>` is a new project (greenfield) or an existing codebase (brownfield), agrees the goal
with the user and ends with an approved `Goal` note (plus `Codebase Examination` when brownfield).
`<projectNoteId>` = `factory.projectNoteId`; `<Factory Log>` = its child titled `Factory Log`
(`mcp__trilium__get_child_notes(<projectNoteId>)`); `<ISO ts>` = `date -u +%Y-%m-%dT%H:%M:%SZ`. Every write follows
`$PLUGIN_ROOT/skills/run/references/trilium-schema.md` (find or create, templates, Agent Run note convention).

- **Free-text question**: AskUserQuestion with the options named; the user types the answer via Other. Keep answers
  verbatim; never invent one.
- **Write `<Title>`** (template from `$PLUGIN_ROOT/skills/run/templates/`): Read the template, fill every
  `{{placeholder}}` (`n/a` when not applicable), keep lines 1–2. `mcp__trilium__get_child_notes(<projectNoteId>)`,
  exact title: found → `mcp__trilium__set_note_content(<noteId>, …)`; absent → `mcp__trilium__create_note` (parent
  `<projectNoteId>`, the title, type `text`, the content). Then one `mcp__trilium__set_attribute` per label named.
- **Export** after every write or edit of a document: `mcp__trilium__get_note_content(<noteId>)` → Write
  `<repoPath>/.factory/docs/<kind>.md`; then refresh copies already in workstreams:
  `for d in "<repoPath>"/.factory/workstreams/*/docs; do [ -d "$d" ] && cp "<repoPath>/.factory/docs/<kind>.md" "$d/"; done`.
- **Dispatch** (`$PLUGIN_ROOT/skills/run/references/agent-protocol.md`): find or create `Agent Runs` under
  `<projectNoteId>` (content `# Agent Runs`, label `#project=<repoName>`). Before the call,
  `mcp__trilium__create_note` there: title `<ISO ts> <agent> pending`,
  content `Dispatched <ISO ts>. Brief: <first line>`, labels `#factoryAgentRun`, `#agentType=<agent>`,
  `#status=running`, `#startedAt=<ISO ts>`, `#project=<repoName>`. Agent call: `subagent_type: "factory:<agent>"`,
  foreground, `description: "<agent> examine [task:none]"`, `prompt` = the five-line brief with absolute paths.
  After it: `mcp__trilium__rename_note` to `<ISO ts> <agent> <agentId>`; set `#agentId=<agentId>`, `#status=done`
  (contract parsed) or `failed`, `#endedAt=<ISO ts>`; `mcp__trilium__append_to_note` the summary lines and the json
  block. Take the last fenced json block and check the contract keys named in the step; none parses or the call
  errors → `failed`, dispatch once more (new run note); a second failure → tell the user the agent's message and
  Stop examine.
- **Stop examine** (a `Stop` answer or a second agent failure):
  `mcp__trilium__append_to_note(<Factory Log>, "- <ISO ts> [examine] stage stopped — <reason>")`;
  `factory-event stage --stage examine --status stopped </dev/null`; leave `#stageExamine` unchanged; end the run.

## Prerequisites

1. `mcp__trilium__get_attributes(<projectNoteId>)` shows `#stageSetup=done`. Else refuse
   `Missing #stageSetup=done on project <repoName>: run /factory:setup first.` and stop.
2. The same result shows `#stageExamine=done` → Direct-command behaviour below before step 1.

## Procedure

1. **Detect the project kind** (paths relative to `<repoPath>`):
   - Tracked source: `git -C "<repoPath>" ls-files | grep -vE '^(\.|docs/|README|LICENSE)' | head -1`
   - Untracked or modified source:
     `git -C "<repoPath>" status --porcelain --untracked-files=all | grep -vE '^.. (\.|docs/|README|LICENSE)' | head -1`
   - Both print nothing → `greenfield`; otherwise `brownfield`. Tell the user one line: the kind and, for
     brownfield, the first path printed.
   - `mcp__trilium__set_attribute(<projectNoteId>, projectKind=<greenfield|brownfield>)`.
   - Greenfield → steps 2–3, then 8–9. Brownfield → steps 4–7, then 8–9.
2. **Greenfield dialogue**: at most three free-text questions, in this order; skip a round the earlier answers
   already cover. `Stop` → Stop examine.
   - Round 1: "What are we building, for whom, and why now?" — options `Show an example answer` (print a two-line
     example, ask again) / `Stop`.
   - Round 2: "Constraints: runtime or language, platform, hosting, technologies you want or must avoid, and
     non-goals?" — options `No constraints yet` / `Stop`.
   - Round 3: "Success criteria: how will we know it works (users, numbers, dates)?" — options `Decide later` /
     `Stop`.
   - `mkdir -p "<repoPath>/.factory/research"`; Write the answers verbatim to
     `<repoPath>/.factory/research/answers.md` under `## What, for whom, why now`, `## Constraints`,
     `## Success criteria` (`not decided yet` for a skipped or `Decide later` round).
3. **Validate the named technologies** (`standards-researcher`). The answers name no technology, runtime or
   service → skip the dispatch; the Goal gets the single row `| none named yet | – | – |`. Otherwise Write
   `<repoPath>/.factory/research/questions.md`: "Validation of a new project's named technologies, not a standards
   decision. Area `runtime`: the language or runtime named in answers.md. Other questions: for each other
   technology named there (framework, database, service, hosting), does it exist, its latest stable version,
   release date, any deprecation or end-of-life notice, and the source URL." Dispatch with:

   ```
   Task: Validate the technologies named for the new project <repoName> [task:none]
   Read first: <repoPath>/.factory/research/questions.md
   Inputs: answers=<repoPath>/.factory/research/answers.md
   Write: <repoPath>/.factory/research/**
   Return: ≤15 lines then exactly one fenced json block matching your contract
   ```

   Contract keys: `report_path`, `recommendations` (each `area`, `choice`, `version`, `why`). Read the report.
   Technology rows, one per recommendation and per technology under the report's `## Other questions`:
   `| <name> | <version> | <source> |` (no verified version → `unverified`; source = the report's URL, else
   `web`). A deprecated or end-of-life item, or a named technology the research could not confirm → one line under
   Open questions, and mention it in step 9's summary.
4. **Graph first** (SOP 5). Preflight `graphify.outPresent=false` (confirm with
   `test -s "<repoPath>/graphify-out/graph.json"`) → Read `$PLUGIN_ROOT/skills/run/stages/graph.md`, follow it, then
   return here. Present → SOP 5 stale check (`cd "<repoPath>" && graphify update .` when the last commit is newer
   than `graph.json`). If the graph stage stops or refuses, continue without a graph.
5. **Examine the codebase** (`codebase-examiner`). Dispatch with (no `GRAPH_REPORT.md` → `Read first: <repoPath>`):

   ```
   Task: Examine the existing codebase of <repoName> [task:none]
   Read first: <repoPath>/graphify-out/GRAPH_REPORT.md
   Inputs: repo=<repoPath>
   Write: <repoPath>/.factory/examine/**
   Return: ≤15 lines then exactly one fenced json block matching your contract
   ```

   Contract keys: `report_path`, `languages`, `frameworks`, `maturity` with `lint`, `tests`, `ci`, `docs` each
   `none` | `partial` | `solid`, `entrypoints`. Read the report.
6. **Write `Codebase Examination`** (template `examination.md`; labels `#factoryDoc=examination`,
   `#project=<repoName>`; export kind `examination`). Fill from the json and the report: `head_sha` =
   `git -C "<repoPath>" rev-parse HEAD` (`none` when preflight `git.hasCommits=false`), `examined_at` = `<ISO ts>`,
   `report_path`, the four maturity levels with their evidence, `risks`, and `graph_status` = whether the examiner
   used the graph or fell back to Grep (its summary says which). Print the Maturity table, languages, frameworks,
   entry points and the top three risks.
7. **Brownfield goal.** Free-text question "What should the factory achieve in this codebase, for whom, and why
   now? Add success criteria and constraints if you have them." — options `Show an example answer` (print one, ask
   again) / `Stop`. The answer has no success criteria → one more free-text question "Success criteria: how will we
   know it works?" — options `Decide later` / `Stop`. `Stop` → Stop examine. Technology rows: one per language and
   framework from step 5, `| <name> | <version from the report, else "–"> | Codebase Examination |`.
8. **Write `Goal`** (template `goal.md`; labels `#factoryDoc=goal`, `#project=<repoName>`, `#approval=pending`;
   export kind `goal`). Fill: `repo_name`; `project_kind` from step 1; `approved_at` = `pending`; `what`, `why`,
   `users` from round 1 or step 7; `constraints` from round 2 or step 7 (brownfield adds "existing stack: <languages,
   frameworks>"); `out_of_scope` = the stated non-goals; `success_criteria` (`not decided yet` when deferred, and
   then also listed in Open questions); `technology_rows` from step 3 or 7; `open_questions` = gaps and research
   warnings, else `n/a`.
9. **Approve the Goal** (human gate). Print a summary of at most 200 words (what, for whom, why, success criteria,
   technologies with versions, open questions) and the Goal note id. AskUserQuestion "Approve this Goal?" — options
   `Approve` / `Edit (tell me what to change)` / `Stop`.
   - `Approve` → `mcp__trilium__set_attribute(<goalNoteId>, approval=approved)`;
     `mcp__trilium__append_to_note(<Factory Log>, "- <ISO ts> [examine] goal approved")`;
     `mcp__trilium__edit_note_content(<goalNoteId>)` replacing `**Approved:** pending` with `**Approved:** <ISO ts>`;
     re-export; go to Completion.
   - `Edit` → the change is the Other text (option picked without text → free-text question "What should change?",
     options `Nothing, ask again` / `Stop`); rewrite the filled template with
     `mcp__trilium__set_note_content(<goalNoteId>, …)`, re-export, ask again.
   - `Stop` → `#approval` stays `pending`; Stop examine.

## Completion

1. `mcp__trilium__set_attribute(<projectNoteId>, stageExamine=done)` (`#projectKind` was set in step 1).
2. `mcp__trilium__append_to_note(<Factory Log>,`
   `"- <ISO ts> [examine] stage done — <greenfield|brownfield>, Goal <goalNoteId> approved")`.
3. `factory-event stage --stage examine --status done </dev/null`.
4. Print one paragraph: the kind, the note ids (`Goal`, `Codebase Examination`), the exports; next stage:
   set-standards.

Exports: project documents live at `<repoPath>/.factory/docs/<kind>.md` (`goal.md`, `examination.md`; later
`standards.md`, `enforcement-plan.md`). set-standards and the agents read them there; workstream stages copy them
into `<repoPath>/.factory/workstreams/<slug>/docs/`, and the Export loop above refreshes those copies on a re-run.

## Direct-command behaviour

`/factory:examine` or `/factory:run examine` when `#stageExamine=done`: AskUserQuestion "examine is already done
(Goal <goalNoteId>). Run it again?" — options `Re-run (overwrite the document, keep labels)` / `Stop`.
- `Stop` → no writes; `factory-event stage --stage examine --status done </dev/null`; stop.
- `Re-run` → steps 1–9 and Completion. `Goal` and `Codebase Examination` are overwritten in place (find or create,
  same note ids); `#stageExamine` stays `done`; the Goal's `#approval` follows steps 8–9. Later stages are not
  reset: when the goal or the stack changed, tell the user to re-run `/factory:set-standards`.

Entered with no verb (`/factory:run`), the stage runs only while `#stageExamine` is unset and continues with
set-standards after Completion; entered as a direct command, stop after Completion.

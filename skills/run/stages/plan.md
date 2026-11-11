# Stage: plan

Turns the workstream's approved documents into `Milestones/M<n> <title>/T-NNN <title>` notes that the execute loop
runs, or realigns existing ones with what has been built and bumps `#planRev`. Notation: `<projectNoteId>` =
`factory.projectNoteId`; `<Factory Log>` = its child titled `Factory Log`; `<slug>` = the `--workstream` value, else
live `factory-config get activeWorkstream --repo "<repoPath>"` (never the preflight snapshot); `<ws>` = its note id;
`<docs>` = `<repoPath>/.factory/workstreams/<slug>/docs`; `<wt>` = `<repoPath>/.factory/worktrees/<slug>`;
`<ISO ts>` = `date -u +%Y-%m-%dT%H:%M:%SZ`. Every write follows
`$PLUGIN_ROOT/skills/run/references/trilium-schema.md`; task notes must satisfy the Preconditions and SELECT of
`$PLUGIN_ROOT/skills/run/references/execute-loop.md`.

- **Write `<Title>` under `<parent>`**: `mcp__trilium__get_child_notes(<parent>)`, exact title: found →
  `mcp__trilium__set_note_content(<noteId>, …)`; absent → `mcp__trilium__create_note` (parent, title, type `text`,
  Markdown content). Then one `mcp__trilium__set_attribute` per label named (markers empty).
- **Export `<kind>`**: `mcp__trilium__get_note_content(<noteId>)` → Write `<docs>/<kind>.md`.
- **Export tasks** (also used by the validate stage): `mcp__trilium__search_notes` for
  `#factoryMilestone #workstream='<slug>' #project='<repoName>'` and `#factoryTask #workstream='<slug>' #project='<repoName>'`;
  `mcp__trilium__get_attributes` of each hit; sort numerically by `#order`. Write
  `<repoPath>/.factory/workstreams/<slug>/tasks.md`: `# Tasks — <slug> (plan rev <rev>)` (`<rev>` = current
  `#planRev` of `<ws>`); `## Milestones` (one line per milestone: `- M<n> <title> (<status>)`); `## Tasks`, a table
  `| id | milestone | title | dependsOn | status |` (one row per task, `–` for no deps); `## Task details`, per task
  `### T-NNN <title>` + its note body (`mcp__trilium__get_note_content`), which carries the acceptance criteria and
  files the adversaries check. In those copies replace the literal `{{interfaces}}` and `{{steps}}` with
  `(filled by the spec-writer at execute)` so they do not read as gaps.
- **Log**: `mcp__trilium__append_to_note(<Factory Log>, "- <ISO ts> [plan] <event>")`.
- **Stop plan** (a `Stop` answer): Log `stage stopped — <reason>`;
  `factory-event stage --stage plan --status stopped --workstream <slug> </dev/null`; leave `#stagePlan` unchanged.

## Prerequisites

1. No `<slug>` → refuse `No active workstream: run /factory:brainstorm first.` and stop. `<ws>` =
   `factory-config get workstreams.<slug>.noteId --repo "<repoPath>"`; on a miss
   `mcp__trilium__search_notes("#factoryWorkstream #slug='<slug>' #project='<repoName>'")` and cache it with
   `factory-config set workstreams.<slug>.noteId <ws> --repo "<repoPath>"`.
2. `mcp__trilium__get_attributes(<ws>)` shows `#stageBrainstorm=done`, and `#stageUiux` and `#stageApi` each `done` or
   `skipped`. Else refuse with the first missing one, e.g. `Missing #stageUiux=done|skipped on workstream <slug>: run
   /factory:uiux first.`, and stop. `<planRev>` = its `#planRev`.
3. `#stagePlan=done`, not entered from the validate stage's `Fix the plan now` → Direct-command behaviour below
   before step 1.

## Procedure

1. **Inputs and mode.** `mcp__trilium__get_child_notes(<ws>)`: Export `spec`, `plan`, `uiux`, `api-design` from the
   notes `Spec`, `Plan`, `UI-UX Spec`, `API Design` (skip absent ones); keep `<planNoteId>` (`Plan`). Copy the project
   exports: `cp "<repoPath>/.factory/docs/goal.md" "<repoPath>/.factory/docs/standards.md" "<docs>/"`. Read them all.
   Mode: `mcp__trilium__search_notes("#factoryMilestone #workstream='<slug>' #project='<repoName>'")` → no hit:
   **Fresh** (step 2); hits: **Realign** (step 3).
2. **Fresh plan.** Derive, then write:
   - Milestones: 2–6, each a working increment in execution order: `M1`, `M2`, … with `#order` 1, 2, ….
   - Tasks: one reviewable change with its own tests (fold setup, config and docs into the task that needs them);
     at most 12 per milestone (3 or more where the work allows), ideally ≤ 20 in total (needs more → say so and
     suggest splitting it into workstreams). Every Spec requirement, every UI-UX flow and state and every API
     operation maps to at least one task. Sources: Spec, Plan, UI-UX Spec, API Design; Standards decide tools and
     test approach, and each Standards item marked `plan applies` (end-to-end suite, health endpoints, telemetry;
     `$PLUGIN_ROOT/skills/run/references/standards-traits.md`) maps to a task of its own unless the repo already
     has it or a task of another workstream covers it (`mcp__trilium__search_notes("#factoryTask
     #project='<repoName>'")`, titles).
   - Ids `T-001`, `T-002`, … numbered globally in dependency order (a task depends only on lower ids; no cycles; no
     task in an earlier milestone than a task it depends on); task `#order` = its number. Ids are never renumbered or
     reused once written: later additions take the next free id and `#order` carries the execution order.
   - Write `Milestones` under `<ws>`: content `# Milestones`; labels `#project=<repoName>`, `#workstream=<slug>`.
   - Per milestone, Write `M<n> <title>` under `Milestones`: content `# M<n> <title>` + its outcome in 1–3 sentences;
     labels `#factoryMilestone`, `#milestoneId=M<n>`, `#order=<n>`, `#status=todo`, `#project=<repoName>`,
     `#workstream=<slug>`.
   - Per task, Write `T-NNN <title>` under its milestone note. Body: Read
     `$PLUGIN_ROOT/skills/run/templates/task-spec.md`; fill `{{task_id}}`, `{{task_title}}`, `{{slug}}`,
     `{{milestone_id}}`, `{{depends_on}}` (the ids, or `none`), `{{plan_rev}}` (`<planRev>`), `{{goal}}` (1–3
     sentences), `{{acceptance_criteria}}` (bullets, each checkable by a test or a command), `{{files}}` (repo-relative
     paths, each marked create or modify), `{{out_of_scope}}`; leave `{{interfaces}}` and `{{steps}}` untouched (the
     spec-writer fills them in execute); keep lines 1–2. Labels: `#factoryTask`, `#taskId=T-NNN`, `#order=<n>`,
     `#milestoneId=M<n>`, `#dependsOn=<ids, e.g. T-001,T-003; empty when none>`, `#status=todo`, `#round=0`,
     `#project=<repoName>`, `#workstream=<slug>`. Never `#factoryDoc` on a task note.
   - Export tasks → step 4.
3. **Realign** (tasks exist: fit them to the documents and to what is built). Read, write nothing yet:
   - `git -C "<wt>" log --oneline -30`; `git -C "<wt>" status --porcelain` (untracked and modified files); skip
     both when `<wt>` does not exist.
   - Every milestone and task (the two searches of Export tasks), with `mcp__trilium__get_attributes`
     (`#status`, `#order`, `#milestoneId`, `#dependsOn`) and the bodies of `todo` tasks.
   - `#stageValidate=fail` on `<ws>` → the newest `<repoPath>/.factory/workstreams/<slug>/validation/findings-R<N>.md`:
     every blocking finding there must be resolved by a change below (or named as not fixable, with the reason).

   Draft a change list, applied only after approval (step 4):
   - Tasks with `#status=done` and their milestones: untouched (labels, title, body, `#order`).
   - Tasks in flight (`#status` neither `todo` nor `done`): untouched; what they lack becomes a new task that depends
     on them.
   - `todo` tasks: change the body, title (`mcp__trilium__rename_note`), `#dependsOn`, `#order`, or milestone
     (`mcp__trilium__move_note` under it + `#milestoneId`), or delete an obsolete one (`mcp__trilium__delete_note`) and
     drop its id from every `#dependsOn`. Never delete or change a task whose `#status` is not `todo`.
   - New tasks: next free ids (above the highest existing; never reuse one), body and labels as in step 2. New
     milestones: next free `M<n>` with `#status=todo`; never add a task to a `done` milestone; a `todo` milestone
     left without tasks is deleted.
   - `#order` stays unique and respects `#dependsOn` among unfinished tasks; work already in git (commits, untracked
     files) is credited, not planned again.
   - Nothing to change → say so; step 4 then offers `Keep the plan as is` in place of `Approve`.
4. **Approval** (the Plan gate, SOP 6).
   - Fresh: present the milestones, the task table and the total, and the path of `tasks.md`.
   - Realign: present the change list as a table `change | id | milestone | title | dependsOn | reason` (change =
     `keep`, `add`, `modify`, `move`, `delete`), with the git evidence behind it.
   - AskUserQuestion `Approve / Edit / Stop`. Edit → the user's changes via Other; Fresh: update the affected notes
     (Write; delete removed tasks, fix `#dependsOn`) and Export tasks; Realign: revise the draft; ask again.
     Stop → Stop plan (Fresh notes stay as `todo`; the next run realigns them).
   - Approve → Log `<slug> plan approved (fresh|realign)`. Realign only: `<newRev>` = `<planRev>` + 1; apply the
     change list (new and changed task bodies carry `{{plan_rev}}` = `<newRev>`);
     `mcp__trilium__set_attribute(<ws>, planRev=<newRev>)` and `mcp__trilium__set_attribute(<planNoteId>,
     planRev=<newRev>)`; `mcp__trilium__append_to_note(<planNoteId>, "## Realign rev <newRev> (<ISO ts>)" + the
     change list)`; Export `plan`; Export tasks. Any `todo` task added or changed and `#stageExecute` set on `<ws>` →
     `mcp__trilium__delete_attribute(<ws>, stageExecute)` (execute has work again). `Keep the plan as is` → nothing
     written, no bump.

## Completion

1. `mcp__trilium__set_attribute(<ws>, stagePlan=done)`. Fresh plan or applied realign →
   `mcp__trilium__set_attribute(<ws>, wsStatus=planned)`; `Keep the plan as is` → `#wsStatus` unchanged (e.g. a
   `paused` set by execute stays).
2. Log `stage done — <slug>: <m> milestones, <n> tasks, plan rev <#planRev>` (realign: add
   `realigned +<added> ~<changed> -<deleted>`).
3. `factory-event stage --stage plan --status done --workstream <slug> </dev/null`.
4. Print one paragraph: milestones, task count, plan rev, `<repoPath>/.factory/workstreams/<slug>/tasks.md`; next
   stage: validate (a bumped `#planRev` always needs a new validation).

## Direct-command behaviour

`/factory:plan` or `/factory:run plan [--workstream <slug>]` when `#stagePlan=done`: AskUserQuestion "plan is
already done for <slug> (plan rev <planRev>). Realign it?" options `Re-run (realign the tasks)` / `Stop`.
- `Stop` → no writes; `factory-event stage --stage plan --status stopped --workstream <slug> </dev/null`; stop.
- `Re-run` → steps 1–4 and Completion (milestones exist → Realign).

Entered from the validate stage's `Fix the plan now` → no question: Realign with that round's findings, then return
to validate. Entered with no verb (`/factory:run`), the stage runs only while `#stagePlan` is unset and continues
with validate; entered as a direct command, stop after Completion.

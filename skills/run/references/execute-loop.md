# Execute loop

The state machine run by the `execute` stage, one task at a time. Labels and titles: `trilium-schema.md`;
briefs, contracts and parsing: `agent-protocol.md`.

## Notation

- `<repo>` repo root (abs), `<slug>` workstream, `<wt>` = `<repo>/.factory/worktrees/<slug>`,
  `<docs>` = `<repo>/.factory/workstreams/<slug>/docs`, `<T>` task id (`T-001`), `<title>` task title,
  `<tn>` task note id, `<ws>` workstream note id, `<log>` Factory Log note id, `<ts>` ISO ts,
  `<taskDir>` = `<repo>/.factory/tasks/<slug>/<T>`, `<n>` review round.
- `create_note`, `get_note_content`, `set_note_content`, `append_to_note`, `rename_note`, `search_notes`,
  `get_attributes`, `set_attribute`, `delete_attribute` mean `mcp__trilium__<name>`.
  `set_attribute(<note>, a=x, b=y)` = one call per label. Every search also carries `#project='<repo>'` (before any
  `orderBy`/`limit`). `<#base>`, `<#lintCmd>`, … = the current value of that label on the note it lives on (schema).
- bin commands are on the Bash PATH (else `$PLUGIN_ROOT/bin/<name>`). Each prints one JSON line.
- Shared steps:
  - **status(S)**: `set_attribute(<tn>, status=S)`; `factory-event task --task <T> --status S --workstream <slug> </dev/null`;
    write the ledger; print one line `<T> <title>: <PHASE> (round <n>)`.
  - **run-start(agentType)** / **run-end**: Agent Run note under `<tn>` per the schema convention; after run-end
    `printf '{"agentType":"%s","agentId":"%s"}' <agentType> <agentId> | factory-event agent --task <T> --status done --workstream <slug>`.
  - **log(msg)**: `append_to_note(<log>, "- <ts> [execute] <T> <msg>")`.
  - **doc(title, template, labels)**: find-or-create `<title>` under `<tn>` (`create_note` type `text` /
    `set_note_content`), body from `$PLUGIN_ROOT/skills/run/templates/<template>.md`, then `set_attribute` the labels
    plus `#project=<repo>`, `#workstream=<slug>`, `#taskId=<T>`.

## Preconditions

0. Resolve `<slug>`: the `--workstream` argument, else `factory-config get activeWorkstream --repo <repo>`. `<ws>` =
   `factory-config get workstreams.<slug>.noteId --repo <repo>`; on a miss search the workstream (schema) and cache it with
   `factory-config set workstreams.<slug>.noteId <id> --repo <repo>`.
1. `get_attributes(<ws>)`: `#stageValidate=pass` and `#validatedPlanRev` equals `#planRev`; else stop: "run validate".
2. `factory-worktree ensure <slug> --repo <repo>` → `{path, branch, created, branchCreated}`. Exit 2 (branch exists,
   not created by the factory) → AskUserQuestion `Adopt branch <slug> / Stop`; adopt = rerun with `--adopt`. Exit 3
   (invalid slug) or 1 → report the `error` and stop. Keep `#worktree` = `path`.
3. `git -C <repo> rev-parse --abbrev-ref HEAD` is `main` and `git -C <repo> status --porcelain` is empty; else stop
   and tell the user (never stash or reset for them).
4. `get_attributes(<Standards>)` → `#lintCmd`, `#testCmd`, `#buildCmd` (empty = none).
5. Re-export `goal`, `standards`, `spec`, `plan`, `uiux`, `api-design` to `<docs>/` (skip absent docs).
6. `factory-event stage --stage execute --status started --workstream <slug> </dev/null`; read the ledger.

## Ledger `.factory/state.json`

```json
{"workstream": "<slug>", "task": {"id": "T-001", "noteId": "<tn>"}, "phase": "SELECT|SPEC|BUILD|REVIEW|FIX|APPROVE|MERGE|DONE|NEEDS-HUMAN", "round": 0, "base": "<sha>", "head": "<sha>", "agents": {"builder": "<agentId>"}, "updatedAt": "<ts>"}
```

- Rewrite the whole file (Write) at every transition, before the new phase's first action. `task` is `null` in SELECT
  before a pick and after FINISH (`phase: "DONE"`). `round`/`base`/`head`/`agents.builder` mirror `#round`, `#base`,
  `#head`, `#builderAgentId`.
- Trilium wins: on start or after compaction, if the ledger disagrees with the task labels, rebuild it from them:

| task `#status` | resume at |
|---|---|
| `spec` | SPEC (dispatch again) |
| `building` | BUILD from step 3, keeping `#base` (`SendMessage` builder "continue and report"; fresh builder if gone) |
| `reviewing` | REVIEW, same `#round` (re-run missing reviewers only) |
| `fixing` | FIX, same `#round` |
| `approving` | APPROVE |
| `merging`, `blocked` | MERGE (`blocked` = conflict sub-flow) |
| `needs-human` | NEEDS-HUMAN (report again, stop) |

## Task files (`<taskDir>/`)

`brief.md` (SPEC), `spec.md` (spec-writer), `report.md` (BUILD creates, builder appends), `review-R<n>.diff`,
`review-R<n>-<reviewer>.json`, `findings-R<n>.md` + `open-findings-R<n>.json` (FIX), `approval.diff`, `reviews-R<n>.json`
(APPROVE), `conflict-<k>.diff` + `conflict-<k>.txt` (MERGE).

## State table

| State | Action | Trilium | Next |
|---|---|---|---|
| SELECT | resume in-flight task, else next `todo` (deps done); none → FINISH | `#wsStatus=executing` | SPEC |
| SPEC | export task + plan constraints + Standards + docs to `<taskDir>/brief.md`; spawn spec-writer | `#status=spec`; Agent Run; `Task Spec` note | BUILD; NEEDS_CONTEXT → answer (or ask user) → SendMessage |
| BUILD | `#base`=HEAD(branch); spawn builder (worktree, spec, report path, lint/test cmds) | `#status=building #round=0 #builderAgentId` | DONE → REVIEW; NEEDS_CONTEXT → SendMessage; BLOCKED → NEEDS-HUMAN(builder-blocked) |
| REVIEW | `round+=1`; `factory-review-package`; one message, four Agent calls; wait for all | `#status=reviewing #round #head`; 4 Review notes + runs | all PASS → APPROVE; CHANGES ∧ round ≤ 2 → FIX; CHANGES ∧ round = 3 → NEEDS-HUMAN(fix-cap); reviewer error twice → NEEDS-HUMAN(reviewer-failed) |
| FIX | `SendMessage(builder, critical+important findings)`; agent gone → fresh builder | `#status=fixing`; append Build Report | REVIEW (scoped prev head..new head) |
| APPROVE | spawn approver (spec, report, full package, 4 review JSONs, Standards) | `#status=approving`; Approval note | APPROVE → MERGE; ESCALATE → NEEDS-HUMAN(approver) |
| MERGE | `factory-merge`; `#testCmd` smoke on main | `#status=merging` | merged → DONE; conflict → `#status=blocked #escalation=merge-conflict` sub-flow |
| DONE | graph refresh; milestone check | `#status=done #mergedSha`; log | SELECT |
| NEEDS-HUMAN | report, stop | `#status=needs-human #escalation`; `#wsStatus=paused` | approve → MERGE; reject → FIX |
| FINISH | all tasks done | `#wsStatus=done #stageExecute=done` | offer `factory-worktree remove` |

## SELECT

1. `search_notes("#factoryTask #workstream='<slug>' #status!=todo #status!=done limit 1")` → found: resume per the table.
2. Else `search_notes("#factoryTask #workstream='<slug>' #status=done")` → done ids; then
   `search_notes("#factoryTask #workstream='<slug>' #status=todo orderBy #order asc")`, sort by numeric `#order`, pick
   the first whose `#dependsOn` ids are all done.
3. No todo task → FINISH. Todo tasks but none ready → log `waiting on deps`, report the unmet ids, stop.
4. `set_attribute(<ws>, wsStatus=executing)`. Milestone: `search_notes("#factoryMilestone #workstream='<slug>' #milestoneId='<M>'")`;
   if its `#status=todo` → `set_attribute(<milestone>, status=active)`.
5. `mkdir -p <taskDir>`; ledger `{task:{id,noteId}, phase:"SPEC", round:0, base:"", head:"", agents:{}}`; log `selected` → SPEC.

## SPEC

1. status(spec).
2. Write `<taskDir>/brief.md`: `get_note_content(<tn>)` (task body), `## Plan constraints` (this task's and its milestone's
   lines from `<docs>/plan.md`), `## Documents` (paths in `<docs>/`), `## Commands` (lint/test/build or none).
3. run-start(spec-writer); Agent `factory:spec-writer`, description `spec-writer <T> [task:<tn>]`, prompt:
   ```
   Task: Write the implementation spec for <T> <title> [task:<tn>]
   Read first: <taskDir>/brief.md
   Inputs: docs=<docs>/, standards=<docs>/standards.md, template=$PLUGIN_ROOT/skills/run/templates/task-spec.md
   Write: <taskDir>/spec.md
   Return: ≤15 lines then exactly one fenced json block matching your contract
   ```
4. `DONE` → doc(`Task Spec`, task-spec, `#factoryDoc=task-spec`) with `spec.md` as body; run-end; log `spec written` → BUILD.
   `NEEDS_CONTEXT` → answer each `open_questions` item from `<docs>/` (AskUserQuestion for the rest) →
   `SendMessage(to: <agentId>, "[task:<tn>] Answers: 1. … Return the same contract.")` → parse again.
   BLOCKED → run-end (`failed`), respawn once; again → NEEDS-HUMAN(`builder-blocked`, "spec-writer: <reason>").

## BUILD

1. `git -C <wt> rev-parse HEAD` → `set_attribute(<tn>, base=<sha>, round=0)`; status(building).
2. Write `<taskDir>/report.md` from `$PLUGIN_ROOT/skills/run/templates/build-report.md` (header filled; the builder
   appends one `## Round <n>` section per round in the shape shown there).
3. run-start(builder); Agent `factory:builder`, description `builder <T> [task:<tn>]`, prompt:
   ```
   Task: Implement <T> <title> in the worktree [task:<tn>]
   Read first: <taskDir>/spec.md
   Inputs: worktree=<wt>, branch=<slug>, report=<taskDir>/report.md, lint=`<#lintCmd>`, test=`<#testCmd>`, build=`<#buildCmd>`
   Write: <wt>/**, <taskDir>/report.md
   Return: ≤15 lines then exactly one fenced json block matching your contract
   ```
4. `set_attribute(<tn>, builderAgentId=<agentId>)`; ledger `agents.builder`; run-end.
5. `DONE` | `DONE_WITH_CONCERNS` → if `git -C <wt> rev-parse HEAD` equals `#base`, treat as BLOCKED ("no commits");
   else doc(`Build Report`, build-report, `#factoryDoc=build-report`) with `report.md` as body; log concerns → REVIEW.
   `NEEDS_CONTEXT` → answer (docs, else AskUserQuestion) → `SendMessage(to: <#builderAgentId>, …)` → parse again.
   `BLOCKED` → NEEDS-HUMAN(`builder-blocked`).

## REVIEW

1. `prev` = current `#head` (unused when `n = 1`). From BUILD/FIX `n = #round + 1`; resuming an interrupted REVIEW keeps `n`.
   `git -C <wt> rev-parse HEAD` → `set_attribute(<tn>, round=<n>, head=<sha>)`; status(reviewing).
2. `factory-review-package <wt> <from> <head> --out <taskDir>/review-R<n>.diff` with `<from>` = `#base` when `n = 1`,
   else `prev` (scoped). Prints `{path, commits, filesChanged}`; non-zero exit → report `error`, stop.
3. run-start × 4, then ONE assistant message with four Agent calls (`factory:security-reviewer`, `factory:ux-reviewer`,
   `factory:ui-design-reviewer`, `factory:code-reviewer`), `run_in_background: false`, descriptions `<agent> <T> R<n> [task:<tn>]`.
   Wait for all four. Prompt (Inputs per agent from the protocol table; `open=` only when `n > 1`):
   ```
   Task: <Security|UX|UI design|Code> review of <T> round <n> [task:<tn>]
   Read first: <taskDir>/review-R<n>.diff
   Inputs: spec=<taskDir>/spec.md, report=<taskDir>/report.md, worktree=<wt>, round=<n>, open=<taskDir>/open-findings-R<n-1>.json
   Write: none
   Return: ≤15 lines then exactly one fenced json block matching your contract
   ```
4. Per result: parse, recompute `verdict`, write `<taskDir>/review-R<n>-<reviewer>.json`; doc(`Review R<n> <reviewer>`,
   review, `#factoryReview`, `#round=<n>`, `#reviewer=<reviewer>`, `#verdict=PASS|CHANGES`); run-end. A failed reviewer is
   respawned once alone; fails again → NEEDS-HUMAN(`reviewer-failed`).
5. log `R<n> security=… ux=… ui-design=… code=…`. All PASS → APPROVE; any CHANGES and `n ≤ 2` → FIX; any CHANGES and
   `n = 3` → NEEDS-HUMAN(`fix-cap`). Minor findings never cause CHANGES.

## FIX

1. status(fixing).
2. Unless `n = 0` (after reject; the findings file exists): from `review-R<n>-*.json` collect every `critical`/`important`
   finding and every `NOT_ADDRESSED` item → `<taskDir>/open-findings-R<n>.json` (array of `{reviewer, id, severity, file,
   line, summary, fix}`) and `<taskDir>/findings-R<n>.md` (grouped by file: `- <id> <severity> L<line>: <summary> — fix: <fix>`).
3. run-start(builder); `SendMessage(to: <#builderAgentId>, "[task:<tn>] Fix round <n>: read <taskDir>/findings-R<n>.md. Fix
   every finding, rerun lint and test, commit on <slug>, append a 'Round <n>' section to <taskDir>/report.md. Return the
   same contract.")`. SendMessage error → fresh `factory:builder` with the BUILD prompt plus `findings=<taskDir>/findings-R<n>.md`
   in Inputs and `Task: Fix round <n> of <T> <title> [task:<tn>]`; `set_attribute(<tn>, builderAgentId=<new id>)`, ledger.
4. run-end. `DONE` | `DONE_WITH_CONCERNS` → `append_to_note(<Build Report>, <the new Round <n> section of report.md>)` → REVIEW.
   `NEEDS_CONTEXT` → answer → SendMessage. `BLOCKED` → NEEDS-HUMAN(`builder-blocked`).

## APPROVE

1. status(approving).
2. `factory-review-package <wt> <#base> <#head> --out <taskDir>/approval.diff` (full package).
3. Write `<taskDir>/reviews-R<n>.json` = array of the four `review-R<n>-<reviewer>.json` of the final round.
4. run-start(approver); Agent `factory:approver`, description `approver <T> R<n> [task:<tn>]`, prompt:
   ```
   Task: Approve or escalate <T> <title> for merge [task:<tn>]
   Read first: <taskDir>/spec.md
   Inputs: report=<taskDir>/report.md, package=<taskDir>/approval.diff, reviews=<taskDir>/reviews-R<n>.json, standards=<docs>/standards.md
   Write: none
   Return: ≤15 lines then exactly one fenced json block matching your contract
   ```
5. doc(`Approval R<n>`, approval, `#factoryDoc=approval`, `#round=<n>`, `#verdict=APPROVE|ESCALATE`); run-end.
   `APPROVE` → MERGE; `ESCALATE` → NEEDS-HUMAN(`approver`); BLOCKED → respawn once, then NEEDS-HUMAN(`approver`).

## MERGE

1. status(merging).
2. `factory-merge <repo> <slug> "Merge <slug>: <T> <title>"` → exit 0/0/2/3/1:
   - `{"result":"merged","sha"}` → if `#testCmd` is set run `cd <repo> && <testCmd>`; pass → DONE(`sha`); fail → DONE(`sha`),
     log `smoke failed on main <sha>`, then stop the loop and tell the user (never auto-revert).
   - `{"result":"up-to-date"}` → DONE(`git -C <repo> rev-parse HEAD`).
   - `{"result":"conflict","files"}` → conflict sub-flow.
   - `{"result":"dirty","files"}` → `main` has uncommitted changes: touch nothing, show the files, stop (status stays `merging`).
   - `{"result":"error","message"}` → report, stop (status stays `merging`).
3. Conflict sub-flow (attempt `k` = 1, 2):
   1. `set_attribute(<tn>, status=blocked, escalation=merge-conflict)`; `factory-event task --task <T> --status blocked --workstream <slug> </dev/null`; log.
   2. Write the files to `<taskDir>/conflict-<k>.txt`. run-start(builder); `SendMessage(to: <#builderAgentId>, "[task:<tn>]
      Merging <slug> into main conflicts in <taskDir>/conflict-<k>.txt. In <wt>: rebase <slug> onto main, resolve, rerun lint
      and test, append a 'Merge conflict <k>' section to <taskDir>/report.md. Return the same contract.")` (fresh builder if gone).
   3. `git -C <repo> rev-parse main` and `git -C <wt> rev-parse HEAD` → `set_attribute(<tn>, base=<main sha>, head=<sha>)`;
      `factory-review-package <wt> <base> <head> --out <taskDir>/conflict-<k>.diff`.
   4. run-start(code-reviewer); one `factory:code-reviewer`, description `code-reviewer <T> merge-<k> [task:<tn>]`, Read first
      the conflict diff, Inputs `spec`, `report`, `worktree`, `round=<n>`, `conflicts=<taskDir>/conflict-<k>.txt`, `standards`,
      `plan`. `append_to_note(<Build Report>, "## Merge conflict <k> — code review <verdict>" + findings)`; run-end.
   5. PASS → `delete_attribute(<tn>, escalation)`, status(merging), retry step 2. CHANGES → SendMessage builder with the
      findings, review once more; still CHANGES, or a conflict again at `k = 2` → NEEDS-HUMAN(`merge-conflict`).

## DONE

1. status(done); `set_attribute(<tn>, mergedSha=<sha>)`; `delete_attribute(<tn>, escalation)` if present.
2. Graph: the post-merge git hook refreshes `graphify-out/`; if still older than HEAD (SOP 5) run `graphify update .` in `<repo>`.
3. `search_notes("#factoryTask #workstream='<slug>' #milestoneId='<M>' #status!=done")` empty → `set_attribute(<milestone>, status=done)`, log `<M> done`.
4. log `done <sha>`; ledger `phase:"SELECT", task:null, round:0` → SELECT.

## NEEDS-HUMAN(reason)

1. `set_attribute(<tn>, status=needs-human, escalation=<reason>)`; `set_attribute(<ws>, wsStatus=paused)`;
   `factory-event task --task <T> --status needs-human --workstream <slug> </dev/null`; log `needs-human <reason>: <one line>`; ledger.
2. Tell the user what is needed: `fix-cap` → consolidate round 3 as in FIX step 2 and show `<taskDir>/findings-R3.md`; `approver` → the Approval reasons;
   `builder-blocked` → the builder's concerns; `merge-conflict` → the conflict files; `reviewer-failed` → which reviewer.
   Offer `/factory:run approve <T>` and `/factory:run reject <T> "notes"`. Stop the loop.

## Human approve (`run approve <T>`)

1. `search_notes("#factoryTask #workstream='<slug>' #taskId='<T>'")`; `get_attributes(<tn>)` must show `#status=needs-human`, else refuse.
2. doc(`Human Decision`, human-decision, `#factoryDoc=human-decision`, `#verdict=approve`); if it exists, `append_to_note` a dated section.
3. `delete_attribute(<tn>, escalation)`; `set_attribute(<ws>, wsStatus=executing)`; log `human approve`; ledger phase MERGE → MERGE.

## Human reject (`run reject <T> "notes"`)

1. Same lookup and `needs-human` check.
2. doc(`Human Decision`, …, `#verdict=reject`) with the notes.
3. Write `<taskDir>/findings-R0.md` with the notes as finding `HUMAN-1` (`important`); `set_attribute(<tn>, round=0)`;
   `delete_attribute(<tn>, escalation)`; `set_attribute(<ws>, wsStatus=executing)`; log `human reject`; ledger round 0, phase FIX
   → FIX with `n = 0`, then REVIEW round 1 (full `#base`..head).

## FINISH

1. `set_attribute(<ws>, wsStatus=done, stageExecute=done)`; log `stage done — <N> tasks merged`;
   `factory-event stage --stage execute --status done --workstream <slug> </dev/null`; ledger `phase:"DONE", task:null`.
2. AskUserQuestion `Remove worktree (branch kept) / Keep worktree` → `factory-worktree remove <slug> --repo <repo>`
   (`--delete-branch` only if the user asks).

## Loop control

After DONE go to SELECT. Stop on NEEDS-HUMAN, FINISH, a stop condition above (dirty main, merge error, smoke failure,
unmet deps) or a user interrupt. Print one status line after every transition. One task at a time; the four reviewers
are the only parallel agents and run only while the builder is idle.

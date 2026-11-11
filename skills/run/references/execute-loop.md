# Execute loop

The `execute` stage's state machine, one task at a time. Labels, titles and placeholders:
`trilium-schema.md`; briefs, contracts and parsing: `agent-protocol.md`.

## Notation

- `<repoPath>` absolute repo root; `<repoName>` its basename; `<main>` default branch (schema); `<slug>`
  workstream; `<wt>` = `<repoPath>/.factory/worktrees/<slug>`; `<docs>` = `<repoPath>/.factory/workstreams/<slug>/docs`;
  `<T>` task id (`T-001`); `<title>` task title; `<tn>` task note id; `<ws>` workstream note id; `<log>` Factory Log
  note id; `<ts>` ISO ts; `<taskDir>` = `<repoPath>/.factory/tasks/<slug>/<T>`; `<n>` review round; `state.<key>` a
  ledger field.
- Trilium tools below omit the `mcp__trilium__` prefix. `set_attribute(<note>, a=x, b=y)` = one call per label. Every search also carries `#project='<repoName>'` (before any
  `orderBy`/`limit`). `<#base>`, `<#lintCmd>`, … = that label's current value on its note (schema).
- bin commands are on the Bash PATH (else SKILL.md's fallback). Each prints one JSON line. After `SendMessage`, await
  its completion (agent-protocol § Dispatch).
- Shared steps:
  - **head**: `git -C <wt> rev-parse HEAD`.
  - **status(S)**: `set_attribute(<tn>, status=S)`; `factory-event task --task <T> --status S --workstream <slug> </dev/null`;
    write the ledger; print one line `<T> <title>: <PHASE> (round <n>)`.
  - **run-start(agentType)** / **run-end**: Agent Run note under `<tn>` per the schema convention; after run-end
    `printf '{"agentType":"%s","agentId":"%s"}' <agentType> <agentId> | factory-event agent --task <T> --status <s> --workstream <slug>`,
    `<s>` = `failed` for a failed run, else `done`.
  - **log(msg)**: `append_to_note(<log>, "- <ts> [execute] <T> <msg>")`.
  - **doc(title, template, labels)**: find-or-create `<title>` under `<tn>` (schema), body from
    `$PLUGIN_ROOT/skills/run/templates/<template>.md`, then `set_attribute` the labels plus `#project=<repoName>`,
    `#workstream=<slug>`, `#taskId=<T>`. An existing `Human Decision` is append-only: `append_to_note` a new
    section, re-set its labels.

## Preconditions

0. Resolve `<slug>`: the `--workstream` argument, else `factory-config get activeWorkstream --repo <repoPath>`. `<ws>` =
   `factory-config get workstreams.<slug>.noteId --repo <repoPath>`; on a miss search the workstream (schema) and cache it
   with `factory-config set workstreams.<slug>.noteId <id> --repo <repoPath>`.
1. `get_attributes(<ws>)`: `#stageValidate=pass` and `#validatedPlanRev` equals `#planRev`; else stop: "run validate".
2. `#wsStatus=done` → print `workstream <slug> is finished` and stop. Else
   `factory-worktree ensure <slug> --repo <repoPath>` → `{path, …}`. Exit 2 (branch exists,
   not created by the factory) → AskUserQuestion `Adopt branch <slug> / Stop`; adopt = rerun with `--adopt`. Exit 3
   (invalid slug) or 1 → report the `error` and stop. If `path` differs from `#worktree`: `set_attribute(<ws>, worktree=<path>)`.
3. `git -C <repoPath> rev-parse --abbrev-ref HEAD` is `<main>` and `git -C <repoPath> status --porcelain` is empty.
   Entries only for `.gitignore`/`.gitattributes` → run SOP 4's working-files commit and re-check; anything else →
   stop and tell the user (never stash or reset for them).
4. `get_attributes(<Standards>)` → `#lintCmd`, `#testCmd`, `#buildCmd` (empty = none), `#postMergeSmoke` (absent = `false`).
5. Refresh `<repoPath>/.factory/docs/{goal,standards}.md` from Trilium, then copy them into `<docs>/`; re-export `spec`,
   `plan`, `uiux`, `api-design` to `<docs>/` (skip absent).
6. Read the ledger (SKILL.md already sent `started`).

## Ledger `.factory/state.json`

```json
{"workstream":"<slug>","task":{"id":"T-001","noteId":"<tn>"},"phase":"SELECT|SPEC|BUILD|REVIEW|FIX|APPROVE|MERGE|DONE|NEEDS-HUMAN","round":0,"base":"<sha>","head":"<sha>","prevHead":"<sha>","agents":{"builder":"<agentId>"},"updatedAt":"<ts>"}
```

- Rewrite the whole file at every transition, before the new phase's first action. `task` is `null` in SELECT
  before a pick and after FINISH (`phase: "DONE"`). `round`/`base`/`head`/`agents.builder` mirror `#round`, `#base`,
  `#head`, `#builderAgentId`. `prevHead` is ledger-only: the head the previous review saw, start of the next scoped
  diff (`""` = none; if lost, use `#base`).
- Trilium wins: on start or after compaction, read the ledger, match the resume table, then, if the ledger disagrees
  with the task labels, rebuild it from them: labels override only label-backed fields; ledger-only fields
  (`prevHead`, `agents` other than `builder`) are kept; `agents.builder` is rebuilt from `#builderAgentId`.

| task `#status` | resume at (first matching row; ledger as read, before the rebuild) |
|---|---|
| `building`/`fixing`, ledger `phase: "REVIEW"`, `round` = `#round` (bump window: step 1 stopped after the bump) | head → `set_attribute(<tn>, head=<head>)` (builder idle), status(reviewing), then REVIEW resume branch of step 1; never BUILD/FIX at that round |
| `spec` | SPEC step 1 |
| `building` | keep `#base`. `state.agents.builder` set → `SendMessage(to: <state.agents.builder>, "[task:<tn>] Continue from your report <taskDir>/report.md and finish the task. Return the same contract.")`, then BUILD step 5. No id or SendMessage error → fresh builder: BUILD step 3 prompt, `Task: Continue <T> <title> from your report <taskDir>/report.md [task:<tn>]` (step 2 first if `report.md` is missing), then steps 4–5 |
| `reviewing` | REVIEW, resume branch of step 1 |
| `fixing` | FIX, same `#round` |
| `approving` | APPROVE |
| `merging` | MERGE step 2 |
| `blocked` | MERGE conflict sub-flow, Resume (never `factory-merge` first) |
| `needs-human` | NEEDS-HUMAN step 2 (report again, stop) |

## Task files (`<taskDir>/`)

SPEC `brief.md`, `spec.md`; BUILD `report.md`; REVIEW `review-R<n>.diff`, `review-R<n>-<reviewer>.json`; FIX/fix-cap
`findings-R<n>.md`, `open-findings-R<n>.json`; reject `findings-R<n>-human.md`, `open-findings-R<n>-human.json`; APPROVE
`approval.diff`, `reviews-R<n>.json`; MERGE `merge-msg.txt`, `conflict-<k>.txt|.diff`, `conflict-<k>-review.json`, `conflict-<k>-findings.md|.json`,
`conflict-<k>-r2.diff`, `conflict-<k>-r2-review.json`.

## State table

| State | Action | Trilium | Next |
|---|---|---|---|
| SELECT | in-flight task, else next ready `todo` | `#wsStatus=executing` | SPEC; none → FINISH; paused → ask |
| SPEC | `brief.md`; spec-writer | `#status=spec`; `Task Spec` | BUILD; BLOCKED twice → NEEDS-HUMAN(spec-failed) |
| BUILD | `#base`; builder | `#status=building #round=0 #builderAgentId` | REVIEW; BLOCKED / no commit → NEEDS-HUMAN(builder-blocked) |
| REVIEW | round + 1; package; four reviewers | `#round #head`, then `#status=reviewing`; Review notes | APPROVE, FIX or NEEDS-HUMAN(fix-cap, reviewer-failed): steps 4–5 |
| FIX | findings → builder | `#status=fixing`; Build Report | REVIEW (scoped); BLOCKED / no commit → NEEDS-HUMAN(builder-blocked) |
| APPROVE | full package; approver | `#status=approving`; Approval | MERGE; ESCALATE → NEEDS-HUMAN(approver) |
| MERGE | `factory-merge`; opt-in smoke | `#status=merging` | DONE (smoke fail: + `#wsStatus=paused`, stop); conflict → sub-flow (`blocked`) |
| DONE | milestone; graph | `#mergedSha`, milestone, then `#status=done` | SELECT |
| NEEDS-HUMAN | report, stop | `#escalation`, then `#status=needs-human`; `#wsStatus=paused` | approve → MERGE (refused for spec-failed); reject → FIX (spec-failed: SPEC) |
| FINISH | all done | `#wsStatus=done #stageExecute=done` | offer `factory-worktree remove` |

## SELECT

1. `search_notes("#factoryTask #workstream='<slug>' #status!=todo #status!=done limit 1")`. A `needs-human` task →
   NEEDS-HUMAN step 2.
2. `get_attributes(<ws>)`: `#wsStatus=paused` → AskUserQuestion `Continue executing / Stop` (quote the Factory Log lines
   that paused it). Continue → `set_attribute(<ws>, wsStatus=executing)`; Stop → stop.
3. Step 1 found another in-flight task → resume per the table.
4. Else `search_notes("#factoryTask #workstream='<slug>' #status=done")` → done ids; then
   `search_notes("#factoryTask #workstream='<slug>' #status=todo orderBy #order asc")`, sort by numeric `#order`, pick
   the first whose `#dependsOn` ids are all done.
5. No todo task: if `search_notes("#factoryTask #workstream='<slug>'")` returns no task at all → stop and report "no tasks
   for <slug> in <repoName>" (never FINISH on an empty result); else → FINISH.
   Todo tasks but none ready → log `waiting on deps`, report the unmet ids, stop.
6. `set_attribute(<ws>, wsStatus=executing)`. Milestone: `search_notes("#factoryMilestone #workstream='<slug>' #milestoneId='<M>'")`;
   if its `#status=todo` → `set_attribute(<milestone>, status=active)`.
7. `mkdir -p <taskDir>`; ledger `{task:{id,noteId}, phase:"SPEC", round:0, base:"", head:"", prevHead:"", agents:{}}`;
   log `selected` → SPEC.

## SPEC

1. status(spec).
2. Write `<taskDir>/brief.md`: `get_note_content(<tn>)` (task body), `## Plan constraints` (this task's and its milestone's
   lines from `<docs>/plan.md`), `## Documents` (paths in `<docs>/`), `## Commands` (lint/test/build or none), and
   `## Human notes` when a reject after `spec-failed` supplied them.
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
   BLOCKED → run-end (`failed`), respawn once (new run note); again → NEEDS-HUMAN(`spec-failed`).

## BUILD

1. head → `set_attribute(<tn>, base=<head>, round=0)`; status(building).
2. Write `<taskDir>/report.md` from `$PLUGIN_ROOT/skills/run/templates/build-report.md` (header filled; the builder
   appends one `## Round <n>` section per round).
3. run-start(builder); Agent `factory:builder`, description `builder <T> [task:<tn>]`, prompt:
   ```
   Task: Implement <T> <title> in the worktree [task:<tn>]
   Read first: <taskDir>/spec.md
   Inputs: worktree=<wt>, branch=<slug>, report=<taskDir>/report.md, lint=`<#lintCmd>`, test=`<#testCmd>`, build=`<#buildCmd>`
   Write: <wt>/**, <taskDir>/report.md
   Return: ≤15 lines then exactly one fenced json block matching your contract
   ```
4. `set_attribute(<tn>, builderAgentId=<agentId>)`; ledger `agents.builder`.
5. run-end. `DONE` | `DONE_WITH_CONCERNS` → if head equals `#base`, treat as BLOCKED ("no commits"); else
   doc(`Build Report`, build-report, `#factoryDoc=build-report`) with `report.md` as body; log concerns → REVIEW.
   `NEEDS_CONTEXT` → answer (docs, else AskUserQuestion) → `SendMessage(to: <#builderAgentId>, …)` → parse again.
   `BLOCKED` → NEEDS-HUMAN(`builder-blocked`).

## REVIEW

1. `n = #round + 1`; `state.prevHead` = `""` from BUILD, `<#head>` from FIX; ledger `phase: "REVIEW"`, `round: n`,
   `prevHead`; then head → `set_attribute(<tn>, round=<n>, head=<head>)`; then status(reviewing), in this order (resume
   table: bump window).
   Resume (status already `reviewing`): `n = #round`; keep `#head` and `state.prevHead`; dispatch only the reviewers that
   have no `<taskDir>/review-R<n>-<reviewer>.json` yet; the others: step 4's doc() from that JSON.
2. Diff: on resume reuse `<taskDir>/review-R<n>.diff` if it exists. Otherwise
   `factory-review-package <wt> <from> <#head> --out <taskDir>/review-R<n>.diff` with `<from>` = `state.prevHead` when
   non-empty (scoped), else `#base`. Non-zero exit → report `error`, stop.
3. `open=`: `<taskDir>/open-findings-R<n-1>-human.json`, else `<taskDir>/open-findings-R<n-1>.json`, if present; else
   omit. run-start per reviewer, then ONE assistant message with the Agent calls (`factory:` + `security-reviewer`,
   `ux-reviewer`, `ui-design-reviewer`, `code-reviewer`), `run_in_background: false`, descriptions
   `<agent> <T> R<n> [task:<tn>]`. Wait for all. Prompt (Inputs per agent from the protocol table):
   ```
   Task: <Security|UX|UI design|Code> review of <T> round <n> [task:<tn>]
   Read first: <taskDir>/review-R<n>.diff
   Inputs: spec=<taskDir>/spec.md, report=<taskDir>/report.md, worktree=<wt>, round=<n>, open=<open file>
   Write: none
   Return: ≤15 lines then exactly one fenced json block matching your contract
   ```
4. Per result: parse, recompute `verdict`, write `<taskDir>/review-R<n>-<reviewer>.json`; doc(`Review R<n> <reviewer>`,
   review, `#factoryReview`, `#round=<n>`, `#reviewer=<reviewer>`, `#verdict=PASS|CHANGES`); run-end. A failed reviewer is
   respawned once alone; fails again → NEEDS-HUMAN(`reviewer-failed`).
5. log `R<n> security=… ux=… ui-design=… code=…`. `h` = `#round` of the task's `Human Decision` when its `#verdict=reject`,
   else 0. All PASS → APPROVE; any CHANGES and `n − h ≤ 2` → FIX; any CHANGES and `n − h ≥ 3` → NEEDS-HUMAN(`fix-cap`).

## FIX

1. status(fixing); `n = #round`.
2. Findings: if `<taskDir>/findings-R<n>-human.md` exists (human reject) use it as is. Otherwise build from
   `review-R<n>-*.json`: every `critical`/`important` finding, plus each `addressed[]` item marked `NOT_ADDRESSED`, copied
   verbatim (`reviewer`, `id`, `severity`, `file`, `line`, `summary`, `fix`) from the `open=` file of round `n` → write
   `<taskDir>/open-findings-R<n>.json` (array) and `<taskDir>/findings-R<n>.md` (grouped by file:
   `- <id> <severity> L<line>: <summary> — fix: <fix>`).
3. run-start(builder); `SendMessage(to: <#builderAgentId>, "[task:<tn>] Fix round <n>: read <findings file>. Fix every
   finding, rerun lint and test, commit on <slug>, append a '<section>' section to <taskDir>/report.md. Return the same
   contract.")` with `<section>` = `Round <n>`, or `Round <n> (human reject)` after a reject. SendMessage error → fresh
   `factory:builder` with the BUILD prompt plus `findings=<findings file>` in Inputs and
   `Task: Fix round <n> of <T> <title> [task:<tn>]`; `set_attribute(<tn>, builderAgentId=<new id>)`, ledger.
4. run-end. `DONE` | `DONE_WITH_CONCERNS` → if head equals `#head` (or `#base` when `#head` is empty) treat as BLOCKED
   ("no new commits"); else `append_to_note(<Build Report>, <the new section of report.md>)` → REVIEW.
   `NEEDS_CONTEXT` → answer → SendMessage → parse again. `BLOCKED` → NEEDS-HUMAN(`builder-blocked`).

## APPROVE

1. status(approving).
2. `factory-review-package <wt> <#base> <#head> --out <taskDir>/approval.diff`.
3. Write `<taskDir>/reviews-R<n>.json` = array of the four `review-R<n>-<reviewer>.json`.
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
2. Write `Merge <slug>: <T> <title>` to `<taskDir>/merge-msg.txt`; `factory-merge <repoPath> <slug> --message-file
   <taskDir>/merge-msg.txt` → exit 0/0/2/3/1:
   - `{"result":"merged","sha"}` → smoke only when `#postMergeSmoke=true` and `#testCmd` is set: `cd <repoPath> &&
     <#testCmd>`. Pass or no smoke → DONE(`sha`). Fail → DONE steps 1–3 with `sha`, then `set_attribute(<ws>,
     wsStatus=paused)`, log `smoke failed on <main> <sha>`, tell the user, stop (never auto-revert; SELECT step 2 asks).
   - `{"result":"up-to-date"}` → DONE(`git -C <repoPath> rev-parse HEAD`).
   - `{"result":"conflict","files"}` → conflict sub-flow.
   - `{"result":"dirty","files"}` (touch nothing, show them) or `{"result":"error","message"}`
     → report, stop (status stays `merging`).
3. Conflict sub-flow:
   1. `k` = highest existing `<taskDir>/conflict-<k>.txt` + 1 (1 if none); `k > 2` → NEEDS-HUMAN(`merge-conflict`).
      `set_attribute(<tn>, status=blocked, escalation=merge-conflict)`;
      `factory-event task --task <T> --status blocked --workstream <slug> </dev/null`; log `merge conflict <k>`.
      Write the files to `<taskDir>/conflict-<k>.txt`; `state.prevHead = <#head>`; ledger.
   2. run-start(builder); `SendMessage(to: <#builderAgentId>, "[task:<tn>] Merging <slug> into <main> conflicts in
      <taskDir>/conflict-<k>.txt. In <wt>: rebase <slug> onto <main>, resolve, rerun lint and test, append a 'Merge conflict
      <k>' section to <taskDir>/report.md. Return the same contract.")`. SendMessage error → fresh `factory:builder` with the
      BUILD prompt, `Task: Resolve merge conflict <k> of <T> <title> [task:<tn>]`, `conflicts=<taskDir>/conflict-<k>.txt`
      in Inputs; `set_attribute(<tn>, builderAgentId=<new id>)`; ledger.
   3. run-end. `DONE` | `DONE_WITH_CONCERNS` → if head equals `state.prevHead` treat as BLOCKED ("no new commits"); else
      continue. `BLOCKED` | `NEEDS_CONTEXT` → NEEDS-HUMAN(`merge-conflict`) with the builder's concerns.
   4. `git -C <repoPath> rev-parse <main>` → `<m>`; head → `set_attribute(<tn>, base=<m>, head=<head>)`;
      `factory-review-package <wt> <m> <head> --out <taskDir>/conflict-<k>.diff`.
   5. run-start(code-reviewer); Agent `factory:code-reviewer`, description `code-reviewer <T> merge-<k> [task:<tn>]`, prompt:
      ```
      Task: Code review of merge-conflict resolution <k> of <T> <title> [task:<tn>]
      Read first: <taskDir>/conflict-<k>.diff
      Inputs: spec=<taskDir>/spec.md, report=<taskDir>/report.md, worktree=<wt>, round=<n>, conflicts=<taskDir>/conflict-<k>.txt, standards=<docs>/standards.md, plan=<docs>/plan.md
      Write: none
      Return: ≤15 lines then exactly one fenced json block matching your contract
      ```
      Parse, write `<taskDir>/conflict-<k>-review.json`; `append_to_note(<Build Report>, "## Merge conflict <k> review
      <verdict>" + findings)`; run-end.
   6. PASS → `delete_attribute(<tn>, escalation)`; status(merging); re-run `factory-merge` (MERGE step 2).
   7. CHANGES (one extra round only): `critical`/`important` findings → `<taskDir>/conflict-<k>-findings.md|.json`;
      `state.prevHead = <#head>`; ledger; run-start(builder); `SendMessage(to: <#builderAgentId>, "[task:<tn>] Fix the findings in
      <taskDir>/conflict-<k>-findings.md, rerun lint and test, commit, append a 'Merge conflict <k> fixes' section to
      <taskDir>/report.md. Return the same contract.")`; run-end; result as in step 3; head → `set_attribute(<tn>, head=<head>)`;
      `factory-review-package <wt> <state.prevHead> <#head> --out <taskDir>/conflict-<k>-r2.diff`; run-start(code-reviewer);
      step 5 prompt with `Read first: <taskDir>/conflict-<k>-r2.diff` and `open=<taskDir>/conflict-<k>-findings.json`;
      write `<taskDir>/conflict-<k>-r2-review.json`; run-end; append to the Build Report. PASS → step 6; CHANGES →
      NEEDS-HUMAN(`merge-conflict`).
   8. Resume (`blocked`): `k` = highest existing `conflict-<k>.txt` (no increment). `conflict-<k>-review.json` PASS, or
      `conflict-<k>-r2-review.json` PASS → step 6. Review CHANGES and r2 CHANGES → NEEDS-HUMAN(`merge-conflict`). Review
      CHANGES, no r2 → step 7 (skip its SendMessage when head differs from a non-empty `state.prevHead`). No review: head
      equals a non-empty `state.prevHead` → step 2; else → step 4. `factory-merge` runs only from step 6.

## DONE

1. `set_attribute(<tn>, mergedSha=<sha>)`; `delete_attribute(<tn>, escalation)` if present. Milestone:
   `search_notes("#factoryTask #workstream='<slug>' #milestoneId='<M>' #status!=done")` returns no task other than `<T>` →
   `set_attribute(<milestone>, status=done)`, log `<M> done`.
2. status(done).
3. Graph: the post-merge git hook refreshes `graphify-out/`; if still older than HEAD (SOP 5) run `graphify update .` in `<repoPath>`.
4. log `done <sha>`; ledger `phase:"SELECT", task:null, round:0, prevHead:""` → SELECT (unless MERGE said stop).

## NEEDS-HUMAN(reason)

1. `set_attribute(<tn>, escalation=<reason>)` first, then status(needs-human); `set_attribute(<ws>, wsStatus=paused)`;
   log `needs-human <reason>: <one line>`.
2. Tell the user what is needed: `fix-cap` → consolidate round `n` as in FIX step 2 and show `<taskDir>/findings-R<n>.md`;
   `approver` → the Approval reasons; `builder-blocked` → the builder's concerns; `spec-failed` → the spec-writer's reason;
   `merge-conflict` → the conflict files and last review; `reviewer-failed` → which reviewer. Offer
   `/factory:run approve <T>` (not for `spec-failed`) and `/factory:run reject <T> "notes"`. Stop the loop.

## Human approve (`run approve <T>`)

1. `search_notes("#factoryTask #workstream='<slug>' #taskId='<T>'")`; `get_attributes(<tn>)` must show `#status=needs-human`,
   else refuse. `#escalation=spec-failed` → refuse too (nothing to merge; use reject with notes).
2. doc(`Human Decision`, human-decision, `#factoryDoc=human-decision`), append-only per doc(); then
   `set_attribute(<decision>, verdict=approve, round=<#round>)`.
3. `delete_attribute(<tn>, escalation)`; `set_attribute(<ws>, wsStatus=executing)`; log `human approve`; ledger phase MERGE → MERGE.

## Human reject (`run reject <T> "notes"`)

1. Same lookup and `needs-human` check; `<esc>` = the current `#escalation` value (read before anything is deleted).
2. `Human Decision` as in approve step 2 with the notes in the section, then `set_attribute(<decision>, verdict=reject, round=<#round>)`.
3. `<esc>` = `spec-failed` → add the notes to `<taskDir>/brief.md` under `## Human notes`; next = SPEC.
   Otherwise `n = #round` (never reset). If `open-findings-R<n>.json` is missing but `review-R<n>-*.json` exist, build it
   first (FIX step 2 rule). `<esc>` = `merge-conflict` → add the open items (FIX step 2 rule) of the highest `k`'s
   `conflict-<k>-r2-review.json` (its `open=` file: `conflict-<k>-findings.json`), else of `conflict-<k>-review.json`.
   Write `<taskDir>/open-findings-R<n>-human.json` = all those entries (if any) plus
   `{"reviewer":"code","id":"HUMAN-1","severity":"important","file":"","line":null,"summary":<notes as JSON string>,"fix":<notes as JSON string>}`,
   and `<taskDir>/findings-R<n>-human.md` = the same union rendered as in FIX step 2; next = FIX (section `Round <n> (human reject)`),
   then REVIEW round `n + 1`.
4. `delete_attribute(<tn>, escalation)`; `set_attribute(<ws>, wsStatus=executing)`; log `human reject`; ledger round
   `#round`, phase = next → next.

## FINISH

1. `set_attribute(<ws>, wsStatus=done, stageExecute=done)`; log `stage done — <N> tasks merged`;
   `factory-event stage --stage execute --status done --workstream <slug> </dev/null`; ledger `phase:"DONE", task:null`.
2. AskUserQuestion `Remove worktree (branch kept) / Keep worktree` → `factory-worktree remove <slug> --repo <repoPath>`
   (`--delete-branch` only if the user asks).

## Loop control

After DONE go to SELECT. Stop on NEEDS-HUMAN, FINISH, any stop condition above, or a user interrupt. FINISH
prints its own status line. One task at a time; the four reviewers are the only parallel agents
and run only while the builder is idle.

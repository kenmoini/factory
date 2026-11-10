# Stage: execute

Operates `$PLUGIN_ROOT/skills/run/references/execute-loop.md` (Read it whole first; it wins any disagreement). Its
notation applies; `<taskDir>` = `<repoPath>/.factory/tasks/<slug>/<T>`; paths are absolute; every search adds
`#project='<repoName>'`.

- **Dispatch**: Agent `subagent_type: "factory:<agent>"`, `description` and five-line `prompt` as shown, foreground,
  no `model` override; an empty Standards command → `<name>=none`. **Parse**: LAST fenced json block (agent-protocol
  § Parsing rule); none parses, or a tool error → BLOCKED.
- **run-start / run-end**: as execute-loop § Notation, around every Agent call and `SendMessage`; run-end's agent
  event uses `--status failed` for a failed run (stdin always the piped JSON payload or `</dev/null`).
- **Answer** (`NEEDS_CONTEXT`): from `<docs>/`, else AskUserQuestion → `SendMessage(to: <agentId>, "[task:<tn>]
  Answers: 1. … Return the same contract.")` → parse again.
- status(S) (writes the ledger `phase`; prints `<T> <title>: <PHASE> (round <n>)`), head, log, doc: execute-loop
  § Notation.

## Prerequisites

Follow execute-loop.md § Preconditions steps 0–4: step 0 resolves `<slug>`/`<ws>` (`factory-config get|set`); step 2
runs `factory-worktree ensure` and re-sets `#worktree` if `path` differs from it. Approve/reject run step 0 only.

5. `get_note_content` + Write: `goal`, `standards` → `<repoPath>/.factory/docs/<kind>.md`, then copy into `<docs>/`;
   `spec`, `plan`, `uiux`, `api-design` → `<docs>/<kind>.md`. Skip absent ones.
6. Stage `started` event already sent by SKILL.md: do not repeat it. Read the Ledger → SELECT.

## Ledger

`<repoPath>/.factory/state.json` (execute-loop § Ledger): rewrite whole at every transition, before the new phase's
first action, setting the fields each phase lists. At start and after compaction: read it and `get_attributes(<tn>)`;
match the resume table's first matching row (bump window first) against the ledger as read; then Trilium wins: rebuild
from the labels (lost `prevHead` → `#base`), log `ledger resynced from Trilium`; resume at the matched row.

## SELECT

Follow execute-loop.md § SELECT.
1. `search_notes("#factoryTask #workstream='<slug>' #status!=todo #status!=done limit 1")`: `needs-human` → NEEDS-HUMAN
   step 2.
2. `get_attributes(<ws>)`: `#wsStatus=paused` → AskUserQuestion `Continue executing / Stop`, quoting the Factory Log
   lines that paused it; Continue → `set_attribute(<ws>, wsStatus=executing)`.
3. Step 1 found another task → its resume table row (even if the plan changed).
4. Before a NEW pick (approve/reject skip the prerequisite table): `#validatedPlanRev` ≠ `#planRev` → stop with "Plan
   changed since validation: run /factory:validate".
5. Pick per execute-loop SELECT steps 4–5. `set_attribute(<ws>, wsStatus=executing)`; milestone (its step 6 search)
   at `#status=todo` → `set_attribute(<milestone>, status=active)`; `mkdir -p <taskDir>`; ledger
   `task:{id,noteId}, phase:"SPEC"`, rest empty/0; log `selected`.

Next: `needs-human` → NEEDS-HUMAN; in-flight → resume table; ready → SPEC; all done → FINISH; else stop.
Print: `<T> <title>: SELECT (round 0)`.

## SPEC

Follow execute-loop.md § SPEC.
1. status(spec).
2. Write `<taskDir>/brief.md` as SPEC step 2; keep an existing `## Human notes` section.
3. run-start(spec-writer); Agent `factory:spec-writer`, description `spec-writer <T> [task:<tn>]`:
   ```
   Task: Write the implementation spec for <T> <title> [task:<tn>]
   Read first: <taskDir>/brief.md
   Inputs: docs=<docs>/, standards=<docs>/standards.md, template=$PLUGIN_ROOT/skills/run/templates/task-spec.md
   Write: <taskDir>/spec.md
   Return: ≤15 lines then exactly one fenced json block matching your contract
   ```
4. Parse; run-end. `DONE` → doc(`Task Spec`, task-spec, `#factoryDoc=task-spec`), body
   `spec.md`; log `spec written`.

Next: `DONE` → BUILD; `NEEDS_CONTEXT` → Answer; BLOCKED → respawn once, again → NEEDS-HUMAN(`spec-failed`).
Print: `<T> <title>: SPEC (round 0)`.

## BUILD

Follow execute-loop.md § BUILD. Resume (`building`): its resume table row, never step 1.
1. head → `set_attribute(<tn>, base=<sha>, round=0)`; status(building); ledger `base`, `round`.
2. Write `<taskDir>/report.md` from `$PLUGIN_ROOT/skills/run/templates/build-report.md`, header filled.
3. run-start(builder); Agent `factory:builder`, description `builder <T> [task:<tn>]`:
   ```
   Task: Implement <T> <title> in the worktree [task:<tn>]
   Read first: <taskDir>/spec.md
   Inputs: worktree=<wt>, branch=<slug>, report=<taskDir>/report.md, lint=`<#lintCmd>`, test=`<#testCmd>`, build=`<#buildCmd>`
   Write: <wt>/**, <taskDir>/report.md
   Return: ≤15 lines then exactly one fenced json block matching your contract
   ```
4. `set_attribute(<tn>, builderAgentId=<agentId>)`; ledger `agents.builder`.
5. Parse; run-end. `DONE`|`DONE_WITH_CONCERNS` with head = `#base` → BLOCKED ("no
   commits"); else doc(`Build Report`, build-report, `#factoryDoc=build-report`), body `report.md`; log concerns.

Next: `DONE`|`DONE_WITH_CONCERNS` → REVIEW (from BUILD); `NEEDS_CONTEXT` → Answer; `BLOCKED` →
NEEDS-HUMAN(`builder-blocked`). Print: `<T> <title>: BUILD (round 0)`.

## REVIEW

Follow execute-loop.md § REVIEW.
1. `n = #round + 1`; `prevHead` = `""` from BUILD, `#head` from FIX; ledger `phase:"REVIEW"`, `round`, `prevHead`;
   then head → `set_attribute(<tn>, round=<n>, head=<sha>)`; then status(reviewing). Resume: `n = #round`, keep
   `prevHead`; `reviewing` → keep `#head`, skip these writes; bump window (resume table) → re-set `#head` only,
   status(reviewing), then continue.
2. `factory-review-package <wt> <from> <#head> --out <taskDir>/review-R<n>.diff`, `<from>` = non-empty `prevHead`
   else `#base` (resume reuses an existing diff); non-zero exit → report `error`, stop.
3. `<open>` = `<taskDir>/open-findings-R<n-1>-human.json`, else `…-R<n-1>.json`, if present; none → drop
   `, open=<open>`. run-start per reviewer (title `<ts> <agent> <reviewer> pending`, renamed `<ts> <agent> <reviewer>
   <agentId>`). Send the four Agent calls in a single assistant message (resume: dispatch only reviewers without
   `review-R<n>-<reviewer>.json`; the others: their JSON from disk, then step 4's doc()); run them in the foreground
   (`run_in_background: false`); wait for all four results. Description
   `<agent> <T> R<n> [task:<tn>]`:
   ```
   Task: <Lens> review of <T> round <n> [task:<tn>]
   Read first: <taskDir>/review-R<n>.diff
   Inputs: spec=<taskDir>/spec.md, report=<taskDir>/report.md, worktree=<wt>, round=<n>, open=<open><extra>
   Write: none
   Return: ≤15 lines then exactly one fenced json block matching your contract
   ```
   `<Lens>`, `<extra>`: `security-reviewer` Security, none; `ux-reviewer` UX, `, uiux=<docs>/uiux.md` (UI-UX
   Spec export; `none` if absent); `ui-design-reviewer` UI design, same + `, mockups=<repoPath>/.factory/mockups/<slug>/`
   (`none` if absent); `code-reviewer` Code, `, standards=<docs>/standards.md, plan=<docs>/plan.md`.
4. Per result: parse; recompute `verdict`; write `<taskDir>/review-R<n>-<reviewer>.json`;
   doc(`Review R<n> <reviewer>`, review, `#factoryReview`, `#round=<n>`, `#reviewer=<reviewer>`, `#verdict`);
   run-end. If a reviewer errors or returns no parseable JSON block (BLOCKED), respawn it once (alone), then
   NEEDS-HUMAN(`reviewer-failed`).
5. From the four `review-R<n>-<reviewer>.json` on disk: log `R<n> security=… ux=… ui-design=… code=…`; `h` =
   `Human Decision` `#round` if its `#verdict=reject`, else 0.

Next: all four PASS → APPROVE; any CHANGES and `n − h ≤ 2` → FIX; any CHANGES and `n − h ≥ 3` →
NEEDS-HUMAN(`fix-cap`); a reviewer fails twice → NEEDS-HUMAN(`reviewer-failed`).
Print: `<T> <title>: REVIEW (round <n>)`.

## FIX

Follow execute-loop.md § FIX.
1. status(fixing); `n = #round`.
2. `<F>` = `<taskDir>/findings-R<n>-human.md` if present; else FIX step 2: `<taskDir>/open-findings-R<n>.json` and
   `<F>` = `<taskDir>/findings-R<n>.md` (critical/important + `NOT_ADDRESSED`, ids verbatim, a `## <file>` heading
   per file, lines `- <id> <severity> L<line>: <summary> — fix: <fix>`).
3. run-start(builder); `SendMessage(to: <#builderAgentId>)` (= ledger `agents.builder`):
   ```
   [task:<tn>] Fix round <n>: read <F>. Fix every finding, rerun lint and test, commit on <slug>, append a '<section>' section to <taskDir>/report.md. Return the same contract.
   ```
   `<section>` = `Round <n>` (`Round <n> (human reject)` for a `-human` `<F>`). SendMessage error → fresh
   `factory:builder` (`builder <T> R<n> [task:<tn>]`), BUILD brief with `Task: Fix round <n> of <T> <title>
   [task:<tn>]` and `, findings=<F>`; `set_attribute(<tn>, builderAgentId=<id>)`; ledger `agents.builder`.
4. Parse; run-end. `DONE`|`DONE_WITH_CONCERNS` with head = `#head` (`#base` if empty) →
   BLOCKED ("no new commits"); else `append_to_note(<Build Report>, <new report.md section>)` (doc() it if absent).

Next: new commits → REVIEW (from FIX, scoped); `NEEDS_CONTEXT` → Answer; `BLOCKED` → NEEDS-HUMAN(`builder-blocked`).
Print: `<T> <title>: FIX (round <n>)`.

## APPROVE

Follow execute-loop.md § APPROVE.
1. status(approving); `n = #round`.
2. `factory-review-package <wt> <#base> <#head> --out <taskDir>/approval.diff`; non-zero → report `error`, stop.
3. `<taskDir>/reviews-R<n>.json` = JSON array of the four `review-R<n>-<reviewer>.json`.
4. run-start(approver); Agent `factory:approver`, description `approver <T> R<n> [task:<tn>]`:
   ```
   Task: Approve or escalate <T> <title> for merge [task:<tn>]
   Read first: <taskDir>/spec.md
   Inputs: report=<taskDir>/report.md, package=<taskDir>/approval.diff, reviews=<taskDir>/reviews-R<n>.json, standards=<docs>/standards.md
   Write: none
   Return: ≤15 lines then exactly one fenced json block matching your contract
   ```
5. Parse; verdict → doc(`Approval R<n>`, approval, `#factoryDoc=approval`, `#round=<n>`,
   `#verdict=APPROVE|ESCALATE`); run-end.

Next: `APPROVE` → MERGE; `ESCALATE` → NEEDS-HUMAN(`approver`); BLOCKED → respawn once, again → NEEDS-HUMAN(`approver`).
Print: `<T> <title>: APPROVE (round <n>)`.

## MERGE

Follow execute-loop.md § MERGE. Resume (`merging`): step 2.
1. status(merging).
2. In `<repoPath>` (`<main>` checkout): write `Merge <slug>: <T> <title>` to `<taskDir>/merge-msg.txt`;
   `factory-merge <repoPath> <slug> --message-file <taskDir>/merge-msg.txt`.

| Result (exit) | Next |
|---|---|
| `merged` (0); smoke (`#postMergeSmoke=true` and `#testCmd` set: `cd <repoPath> && <#testCmd>`) passes or skipped | DONE(`sha`) |
| `merged`, smoke fails | DONE steps 1–3, `set_attribute(<ws>, wsStatus=paused)`, log `smoke failed on <main> <sha>`, tell the user, stop |
| `up-to-date` (0) | DONE(`git -C <repoPath> rev-parse HEAD`) |
| `conflict` (2) / `dirty` (3), `error` (1) | conflict sub-flow / show them, touch nothing, stop |
| sub-flow: `k > 2`; builder BLOCKED, NEEDS_CONTEXT or no new commits; review and r2 CHANGES | NEEDS-HUMAN(`merge-conflict`) |
| sub-flow: review or r2 PASS | s6 → status(merging) → MERGE step 2 |
| resume `blocked` (s8): review CHANGES, no r2 | s7 (no SendMessage if head ≠ a non-empty `prevHead`) |
| resume: no review; head = a non-empty `prevHead` / else | s2 / s4 |

Conflict sub-flow (`#status=blocked`) = execute-loop § MERGE step 3 as written, `s<i>` = its step i: its messages and
code-reviewer brief are the dispatches; ledger `prevHead=<#head>` at s1 and s7; `factory-merge` only from s6.

Print: `<T> <title>: MERGE (round <n>)`.

## DONE

Follow execute-loop.md § DONE.
1. `set_attribute(<tn>, mergedSha=<sha>)`; `delete_attribute(<tn>, escalation)` if present;
   `search_notes("#factoryTask #workstream='<slug>' #milestoneId='<M>' #status!=done")` returns no task other than
   `<T>` → `set_attribute(<milestone>, status=done)`; log `<M> done`.
2. status(done).
3. SOP 5 stale check in `<repoPath>`; stale → `cd <repoPath> && graphify update .`.
4. log `done <sha>`; ledger `phase:"SELECT", task:null, round:0, prevHead:""`.

Next: SELECT (unless MERGE stopped). Print: `<T> <title>: DONE (round <n>)`.

## NEEDS-HUMAN

Follow execute-loop.md § NEEDS-HUMAN(reason). Resume (`needs-human`): step 2 only.
1. `set_attribute(<tn>, escalation=<reason>)` first, then status(needs-human) (ledger `phase:"NEEDS-HUMAN"`);
   `set_attribute(<ws>, wsStatus=paused)`; log `needs-human <reason>: <one line>`.
2. Report per reason as its step 2 (`fix-cap`: consolidate round `n` as FIX step 2, show `findings-R<n>.md`). Offer
   `/factory:run approve <T>` (not for `spec-failed`) and `/factory:run reject <T> "notes"`. Stop the loop.

Next (user verb): `approve <T>` → Human approve → MERGE (refused for `spec-failed`); `reject <T> "notes"` → Human
reject → FIX (`spec-failed`: SPEC). Print: `<T> <title>: NEEDS-HUMAN (round <n>) — <reason>`.

## FINISH

Follow execute-loop.md § FINISH: every task done → Completion. Print: `<slug>: FINISH`.

## Human approve

`/factory:run approve <T>`, after Prerequisites step 0 only. Follow execute-loop.md § Human approve.
1. `search_notes("#factoryTask #workstream='<slug>' #taskId='<T>'")` → `<tn>`; `get_attributes(<tn>)`: not
   `#status=needs-human`; no `#escalation` ("inconsistent state: reject with notes"); or `#escalation=spec-failed`
   ("nothing to merge: reject with notes") → refuse, stop.
2. doc(`Human Decision`, human-decision, `#factoryDoc=human-decision`), append-only per doc(); then
   `set_attribute(<decision>, verdict=approve, round=<#round>)`.
3. `delete_attribute(<tn>, escalation)`; `set_attribute(<ws>, wsStatus=executing)`; log `human approve`; ledger from
   the labels, `phase:"MERGE"`.
4. Load Prerequisites steps 4–5 (data, not gates); MERGE; Loop control until it stops; print the final status.

## Human reject

`/factory:run reject <T> "notes"`, after Prerequisites step 0 only. Follow execute-loop.md § Human reject.
1. Lookup and `needs-human` check as approve step 1 (`spec-failed` allowed); read `<esc>` = `#escalation`, `n = #round`.
2. `Human Decision` as approve step 2, notes in the section; `set_attribute(<decision>, verdict=reject, round=<n>)`.
3. `<esc>` = `spec-failed` → notes under `## Human notes` in `<taskDir>/brief.md`; next = SPEC. Else execute-loop step 3
   (`n` never reset): `<taskDir>/open-findings-R<n>-human.json` = open findings + `HUMAN-1`, `findings-R<n>-human.md` = the
   same union as FIX step 2 renders it; next = FIX (`Round <n> (human reject)`).
4. `delete_attribute(<tn>, escalation)`; `set_attribute(<ws>, wsStatus=executing)`; log `human reject`; ledger from
   the labels, `round:<n>`, `phase:<next>`.
5. As approve step 4, into next.

## Loop control

After DONE → SELECT. Stop on NEEDS-HUMAN, FINISH, SELECT's stops, any other stop above, or a user interrupt; never
ask whether to continue. Each transition prints its status line (status(S) or its `Print:`). One task at a time.
A stop other than FINISH (SOP 2): log `stage stopped — <reason>`;
`factory-event stage --stage execute --status stopped --workstream <slug> </dev/null`. After compaction: the Ledger check before acting.

## Completion

FINISH:
1. `set_attribute(<ws>, wsStatus=done, stageExecute=done)`; log (no `<T>`) `stage done — <N> tasks merged`;
   `factory-event stage --stage execute --status done --workstream <slug> </dev/null`; ledger `phase:"DONE", task:null`.
2. AskUserQuestion `Remove worktree (branch kept) / Keep worktree` → `factory-worktree remove <slug> --repo <repoPath>`
   (`--delete-branch` only if the user asks).
3. Print `<slug>: execute done — <N> tasks merged`.

## Direct-command behaviour

`/factory:execute` or `/factory:run execute` always resumes, idempotently: Prerequisites, Ledger, SELECT (in-flight
or `blocked` task first). `--workstream <slug>` targets that workstream.

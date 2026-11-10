# Stage: validate

Attacks the workstream's task plan with six `plan-adversary` agents, one per lens, dispatched in ONE message, and
records the result as `Validation/Round <N>`. The plan passes only if no lens fails, or the user explicitly accepts
the risks. Notation: `<projectNoteId>` = `factory.projectNoteId`; `<Factory Log>` = its child titled `Factory Log`;
`<slug>` = the `--workstream` value, else live `factory-config get activeWorkstream --repo "<repoPath>"` (never the
preflight snapshot); `<ws>` = its note id; `<docs>` =
`<repoPath>/.factory/workstreams/<slug>/docs`; `<vdir>` = `<repoPath>/.factory/workstreams/<slug>/validation`;
`<ISO ts>` = `date -u +%Y-%m-%dT%H:%M:%SZ`. Writes follow `$PLUGIN_ROOT/skills/run/references/trilium-schema.md`;
dispatch and parsing follow `$PLUGIN_ROOT/skills/run/references/agent-protocol.md`.

- **Write `<Title>` under `<parent>`**: `mcp__trilium__get_child_notes(<parent>)`, exact title: found →
  `mcp__trilium__set_note_content(<noteId>, …)`; absent → `mcp__trilium__create_note` (parent, title, type `text`,
  Markdown content). Then one `mcp__trilium__set_attribute` per label named (markers empty).
- **Log**: `mcp__trilium__append_to_note(<Factory Log>, "- <ISO ts> [validate] <event>")`.
- **Stop validate** (a `Stop` answer or a second adversary failure): Log `stage stopped — <reason>`;
  `factory-event stage --stage validate --status stopped --workstream <slug> </dev/null`; end the run.

Lenses, exactly: `feasibility`, `missing-requirements`, `security`, `ux`, `sequencing`, `standards`.

## Prerequisites

1. No `<slug>` → refuse `No active workstream: run /factory:brainstorm first.` and stop. `<ws>` =
   `factory-config get workstreams.<slug>.noteId --repo "<repoPath>"`; on a miss
   `mcp__trilium__search_notes("#factoryWorkstream #slug='<slug>' #project='<repoName>'")` and cache it with
   `factory-config set workstreams.<slug>.noteId <ws> --repo "<repoPath>"`.
2. `mcp__trilium__get_attributes(<ws>)` shows `#stagePlan=done`. Else refuse `Missing #stagePlan=done on workstream
   <slug>: run /factory:plan first.` and stop. `<planRev>` = its `#planRev`.
3. `#stageValidate=pass` and `#validatedPlanRev` equals `<planRev>` → Direct-command behaviour below before step 1.

## Procedure

1. **Inputs.** `mcp__trilium__get_child_notes(<ws>)`: for each of `Overview`, `Spec`, `Plan`, `UI-UX Spec`,
   `API Design` present, `mcp__trilium__get_note_content` → Write `<docs>/<kind>.md` (`overview`, `spec`, `plan`,
   `uiux`, `api-design`). Copy the project exports:
   `for k in goal standards examination; do f="<repoPath>/.factory/docs/$k.md"; [ -f "$f" ] && cp "$f" "<docs>/"; done`.
   Write `<repoPath>/.factory/workstreams/<slug>/tasks.md` by the **Export tasks** rule of
   `$PLUGIN_ROOT/skills/run/stages/plan.md`. Graph: `<graph>` = `<repoPath>/graphify-out/GRAPH_REPORT.md` if it
   exists (SOP 5 stale check first), else `none`. `mkdir -p "<vdir>"`.
2. **Round.** `mcp__trilium__search_notes("#factoryValidation #workstream='<slug>' #project='<repoName>'")` (all
   rounds, no `orderBy`/`limit`: `#round` may sort as text) → `mcp__trilium__get_attributes` of each → `<N>` = the
   numeric maximum of `#round` + 1; no hit → `<N>` = 1.
3. **Dispatch.** Find or create `Agent Runs` under `<projectNoteId>` (content `# Agent Runs`, label
   `#project=<repoName>`). Per lens, before the call, `mcp__trilium__create_note` there: title
   `<ISO ts> plan-adversary <lens> pending`, content `Dispatched <ISO ts>. Brief: lens=<lens>, round <N>`, labels
   `#factoryAgentRun`, `#agentType=plan-adversary`, `#status=running`, `#startedAt=<ISO ts>`, `#project=<repoName>`,
   `#workstream=<slug>`; keep each note id.
   Then ONE assistant message with six Agent calls, `subagent_type: "factory:plan-adversary"`, foreground,
   `description: "plan-adversary validate R<N> [task:none]"`, prompt (paths absolute, one per lens):

   ```
   Task: Attack the <slug> plan (rev <planRev>) through the <lens> lens [task:none]
   Read first: <repoPath>/.factory/workstreams/<slug>/tasks.md
   Inputs: lens=<lens>, docs=<docs>/, graph=<graph>
   Write: none
   Return: ≤15 lines then exactly one fenced json block matching your contract
   ```

   Wait for all six. Resume: a lens that already has `<vdir>/R<N>-rev<planRev>-<lens>.json` (an interrupted run of
   this round) gets no run note and no Agent call; its file is the result.
4. **Parse** each result (protocol Parsing rule): last fenced json block; `lens` equals the lens sent; `verdict` is
   `PASS` or `FAIL`; each finding has `id`, `severity` (`critical` | `important` | `minor`), `task`, `summary`, `fix`.
   Recompute `verdict` = `FAIL` iff a `critical` or `important` finding exists (note a change in the lens note).
   Write the JSON to `<vdir>/R<N>-rev<planRev>-<lens>.json`. Run note: `mcp__trilium__rename_note` to
   `<ISO ts> plan-adversary <lens> <agentId>`; set `#agentId=<agentId>`, `#status=done` (parsed) or `failed`,
   `#endedAt=<ISO ts>`; `mcp__trilium__append_to_note` the summary lines and the json block. A failed lens (no valid
   block, or an Agent error) → dispatch it once more alone (new run note); failing again → tell the user its message;
   Stop validate (`plan-adversary <lens> failed`).
5. **Round note.** `<verdict>` = `pass` iff no lens is `FAIL`, else `fail`.
   - Write `Validation` under `<ws>`: content `# Validation`; labels `#project=<repoName>`, `#workstream=<slug>`.
   - Write `Round <N>` under `Validation` (its id: `<roundId>`). Body: Read
     `$PLUGIN_ROOT/skills/run/templates/validation.md`; fill `{{round}}`, `{{slug}}`, `{{plan_rev}}` (`<planRev>`),
     `{{verdict}}`, `{{validated_at}}` (`<ISO ts>`), `{{lens_rows}}` (one row per lens: verdict and counts per
     severity), `{{blocking_findings}}` (each `critical` or `important` finding as
     `- <id> (<severity>, <task>): <summary> — fix: <fix>`, or `none`), `{{decision}}` (`pass — no lens failed`, or
     `pending`); keep lines 1–2 and omit the template's "Lens child note body" section. Labels `#factoryValidation`,
     `#round=<N>`, `#planRev=<planRev>`, `#verdict=<verdict>`, `#project=<repoName>`, `#workstream=<slug>`.
   - Per lens, Write `<lens>` under `Round <N>`: body = the template's lens part (`### <lens> — <PASS|FAIL>`, the
     findings table with `{{lens_finding_rows}}`, the parsed json as `{{lens_json}}`); labels `#lens=<lens>`,
     `#round=<N>`, `#verdict=<PASS|FAIL>`, `#project=<repoName>`, `#workstream=<slug>`.
   - `pass` → Completion. `fail` → step 6.
6. **Failed round** (the validation-outcome gate, SOP 6). Write the blocking findings, one line each, to
   `<vdir>/findings-R<N>.md`. Present them grouped by lens (id, task, summary, fix). AskUserQuestion
   `Fix the plan now (go to plan stage) / Accept the risk and pass / Stop`:
   - Fix → `mcp__trilium__set_attribute(<ws>, stageValidate=fail)`; `mcp__trilium__edit_note_content(<roundId>)`:
     decision `fail — back to plan`; Log `stage stopped — R<N> fail, back to plan`;
     `factory-event stage --stage validate --status stopped --workstream <slug> </dev/null`. Then Read
     `$PLUGIN_ROOT/skills/run/stages/plan.md` and run it now (it realigns against `<vdir>/findings-R<N>.md` and bumps
     `#planRev`); when it completes, run this stage again (round `<N>`+1).
   - Accept → `mcp__trilium__set_attribute(<roundId>, verdict=pass)`; `mcp__trilium__edit_note_content(<roundId>)`:
     verdict `pass (risks accepted)`, decision `pass — user accepted the risks: <ids>`; Log
     `R<N> user accepted the risks: <ids>` → Completion.
   - Stop → `mcp__trilium__set_attribute(<ws>, stageValidate=fail)`; `mcp__trilium__edit_note_content(<roundId>)`:
     decision `fail — stopped by the user`; Stop validate (`R<N> fail`).

## Completion

1. `mcp__trilium__set_attribute(<ws>, …)` for `stageValidate=pass`, `validatedPlanRev=<planRev>`, `wsStatus=validated`.
2. Log `stage done — <slug> R<N> pass, plan rev <planRev>` (accepted risks: add `, risks accepted`).
3. `factory-event stage --stage validate --status done --workstream <slug> </dev/null`.
4. Print one paragraph: round, verdict per lens, accepted risks if any, `<roundId>`; next stage: execute.

## Direct-command behaviour

`/factory:validate` or `/factory:run validate [--workstream <slug>]` when `#stageValidate=pass` and
`#validatedPlanRev` equals `#planRev`: AskUserQuestion "Plan rev <planRev> of <slug> already passed validation. Run a
new round (six agents)?" options `Re-run (new round)` / `Stop`.
- `Stop` → no writes, no agents; `factory-event stage --stage validate --status stopped --workstream <slug>
  </dev/null`; stop.
- `Re-run` → steps 1–6 and Completion as round `<N>`.

Any other state (no round yet, `#stageValidate=fail`, or a bumped `#planRev`) runs without the question. Entered with
no verb (`/factory:run`), the stage runs only while it is not done and continues with execute; entered as a direct
command, stop after Completion (or Stop). `Fix the plan now` still runs plan and then this stage, since the user chose
it.

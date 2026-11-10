# Stage: uiux

Decides with the user whether the workstream has UI work; if so, agrees the framework and the UX of each user story,
optionally shows 2–3 visual options as mockups served by the dashboard, and ends with an approved `UI-UX Spec`.
Notation: `<projectNoteId>` = `factory.projectNoteId`; `<Factory Log>` = its child titled `Factory Log`; `<slug>` =
the `--workstream` value, else live `factory-config get activeWorkstream --repo "<repoPath>"` (never the preflight
snapshot: brainstorm may have changed it); `<ws>` = its note id; `<docs>` =
`<repoPath>/.factory/workstreams/<slug>/docs`; `<mock>` = `<repoPath>/.factory/mockups/<slug>`; `<ISO ts>` =
`date -u +%Y-%m-%dT%H:%M:%SZ`. Every write follows `$PLUGIN_ROOT/skills/run/references/trilium-schema.md`.

- **Free-text question**: AskUserQuestion with the options named; the user types the answer via Other. Keep answers
  verbatim; never invent one.
- **Write `<Title>` under `<parent>`**: `mcp__trilium__get_child_notes(<parent>)`, exact title: found →
  `mcp__trilium__set_note_content(<noteId>, …)`; absent → `mcp__trilium__create_note` (parent, title, type `text`,
  Markdown content). Then one `mcp__trilium__set_attribute` per label named.
- **Export `<kind>`**: `mcp__trilium__get_note_content(<noteId>)` → Write `<docs>/<kind>.md`.
- **Log**: `mcp__trilium__append_to_note(<Factory Log>, "- <ISO ts> [uiux] <event>")`.
- **Drafts first.** Until `Approve` in step 6, write only `<draft>` = `<docs>/uiux-draft.md` and mockups (on a
  re-run with an existing `UI-UX Spec`, in `<mock>/next/`); Trilium, `<docs>/uiux.md` and approved mockups stay as
  they are.
- **Stop uiux** (a `Stop` answer): `rm -rf "<draft>" "<mock>/next"`; Log `stage stopped — <reason>`;
  `factory-event stage --stage uiux --status stopped --workstream <slug> </dev/null`; leave `#stageUiux` unchanged.

## Prerequisites

1. No `<slug>` → refuse `No active workstream: run /factory:brainstorm first.` and stop. `<ws>` =
   `factory-config get workstreams.<slug>.noteId --repo "<repoPath>"`; on a miss
   `mcp__trilium__search_notes("#factoryWorkstream #slug='<slug>' #project='<repoName>'")` and cache it with
   `factory-config set workstreams.<slug>.noteId <ws> --repo "<repoPath>"`.
2. `mcp__trilium__get_attributes(<ws>)` shows `#stageBrainstorm=done`. Else refuse `Missing #stageBrainstorm=done on
   workstream <slug>: run /factory:brainstorm first.` and stop. `<planRev>` = its `#planRev`.
3. `#stageUiux` is `done` or `skipped` → Direct-command behaviour below before step 1.

## Procedure

1. **Applicability.** `mcp__trilium__get_child_notes(<ws>)`: Export `spec` and `plan` from `Spec` and `Plan`; copy
   `<repoPath>/.factory/docs/standards.md` into `<docs>/`. Read them. UI work = any screen, page, view, form,
   component or terminal UI a person uses. AskUserQuestion "This plan appears to <involve / not involve> UI work
   (<one-line evidence>). Run the UI/UX stage?" options `Yes` / `Skip` (the one matching your reading first).
   - Skip → `mcp__trilium__set_attribute(<ws>, stageUiux=skipped)`; Log `stage skipped — user chose Skip
     (<evidence>)`; `factory-event stage --stage uiux --status done --workstream <slug> </dev/null`; print one line;
     the stage ends here (no `UI-UX Spec`). On a re-run with `#stageUiux=done`, Skip leaves `done` and the existing
     `UI-UX Spec` unchanged: Log `re-run skipped, earlier UI-UX Spec kept` and send the same event instead.
2. **Existing UI** (`mcp__trilium__get_attributes(<projectNoteId>)` shows `#projectKind=brownfield`; else inventory
   `n/a (greenfield)`). Graph first (SOP 5): Read `<repoPath>/graphify-out/GRAPH_REPORT.md`, then
   `cd "<repoPath>" && graphify query "Which UI framework, component library, styling approach, routes and screens does
   this app have?"`; open only the files it names (package manifest, router, component and style dirs). Summarise in
   ≤ 150 words: framework and version, component library, styling and design tokens, routes or screens.
3. **Questions** (at most 3 AskUserQuestion calls: call 1 = framework + visual design, call 2 = UX per user story,
   call 3 only for gaps):
   - Framework: "Which UI framework and component library?" options: the inventory's stack `(existing)` or the
     Standards' choice `(Standards)` first, then up to 3 fitting alternatives (e.g. `React + Tailwind`,
     `Vue + PrimeVue`, `SvelteKit`, `Plain HTML/CSS`).
   - Visual design: "Do you want to see visual options?" `Yes, show me options` / `No, follow existing style`
     (greenfield: the framework's defaults).
   - UX per user story: Free-text question listing the Spec's user stories, numbered, one line each: "How should
     each of these work for the user: steps, screens, what happens on errors?" options
     `The Spec's flows are right as written` / `Stop`.
   - Gaps (call 3): empty, loading and error states, accessibility needs, target devices.
4. **Mockups** (only for `Yes, show me options`). `<mdir>` = `<mock>`, or `<mock>/next` on a re-run with an existing
   `UI-UX Spec` (URL and paths below then end in `next/`).
   - `mkdir -p "<mdir>"`. Write 2–3 `<mdir>/option-<n>.html`, each a distinct direction (layout, density, palette,
     typography) showing the key screens and states from step 3 with static sample data; its name and a one-line
     rationale at the top. Plain HTML and CSS in one file: inline `<style>`, optional inline `<script>` only to switch
     screens or states; no CDN, web font, remote image or any network URL. Follow the chosen framework's visual idioms
     without importing it.
   - Write `<mdir>/index.html`: heading `<slug> — UI options`, one link per option (`option-<n>.html`) with its name
     and rationale.
   - Mockups live only in `<mock>` (gitignored), never in the repo tree or the worktree.
   - `factory-dashboard open`; `<port>` = `factory-config get dashboardPort 2>/dev/null || echo 7777`. Tell the user
     the URL `http://127.0.0.1:<port>/mockups/<repoName>/<slug>/`. Dashboard not running (`"running":false`, e.g. not
     built) → `factory-dashboard start` once; still down → give the file `<mdir>/index.html` to open in a browser.
   - AskUserQuestion "Which option?" options `Option 1 — <name>` … `Option <n> — <name>` (a mix or changes via Other,
     e.g. "layout of 1, colours of 3"). A mix or changes → update or add an option file (at most 2 revisions) and ask
     again. `<chosen>` = the answer.
5. **Draft UI-UX Spec.** Read `$PLUGIN_ROOT/skills/run/templates/uiux-spec.md`; fill `{{slug}}`, `{{plan_rev}}`
   (`<planRev>`), `{{approved_at}}` = `pending`, `{{applicability}}` (step 1 evidence and answer), `{{framework}}`,
   `{{inventory}}` (step 2), `{{flow_rows}}` (one `| <story> | <flow steps> | <screens> |` row per story),
   `{{screens}}` (purpose, main elements, navigation per screen), `{{states}}` (empty, loading, error, success per
   screen), `{{accessibility}}` (WCAG 2.2 AA baseline: keyboard, focus order, contrast, labels; plus the user's needs),
   `{{mockups_path}}` = `<mock>/`, `{{mockups_url}}` (the step 4 URL without `next/`), `{{chosen_option}}` =
   `<chosen>`, `{{visual_notes}}` (colours, type scale, spacing taken from the chosen option), `{{open_questions}}`
   (or `none`); no mockups → `{{mockups_path}}`, `{{mockups_url}}`, `{{chosen_option}}` = `n/a` and
   `{{visual_notes}}` = the style to follow (existing UI, or the framework's defaults); keep lines 1–2. Write it to
   `<draft>`.
6. **Approval.** Summarise from `<draft>` (framework, stories and flows, chosen option, the draft path).
   AskUserQuestion `Approve / Edit / Stop`.
   - Edit → the user's changes via Other; update `<draft>`; ask again. Stop → Stop uiux.
   - Approve → in `<draft>` replace `**Approved:** pending` with `**Approved:** <ISO ts>`. If `<mock>/next` exists:
     `rm -f "<mock>"/*.html && mv "<mock>/next"/*.html "<mock>/" && rmdir "<mock>/next"`. Write `UI-UX Spec` under
     `<ws>` with the draft content; labels `#factoryDoc=uiux`, `#approval=approved`, `#project=<repoName>`,
     `#workstream=<slug>`. Export `uiux`; `rm -f "<draft>"`; Log `<slug> UI-UX Spec approved`.

## Completion

1. `mcp__trilium__set_attribute(<ws>, stageUiux=done)`.
2. Log `stage done — <slug>: <framework>, option <chosen>` (or `no mockups`).
3. `factory-event stage --stage uiux --status done --workstream <slug> </dev/null`.
4. Print one paragraph: framework, chosen option and mockup URL, `<docs>/uiux.md`; next stage: api-design.

## Direct-command behaviour

`/factory:uiux` or `/factory:run uiux [--workstream <slug>]` when `#stageUiux` is `done` or `skipped`:
AskUserQuestion "uiux is already <done|skipped> for <slug>. Run it again?" options
`Re-run (overwrite UI-UX Spec and mockups)` / `Stop`.
- `Stop` → no writes; `factory-event stage --stage uiux --status stopped --workstream <slug> </dev/null`; stop.
- `Re-run` → steps 1–6 and Completion. `#stageUiux` keeps its value until Completion; `Skip` in step 1 never turns an
  earlier `done` into `skipped`. When `#stagePlan=done` on `<ws>`, end by telling the user to run `/factory:plan` so
  the tasks are realigned with the new UI-UX Spec.

Entered with no verb (`/factory:run`), the stage runs only while `#stageUiux` is unset and continues with api-design
after Completion; entered as a direct command, stop after Completion.

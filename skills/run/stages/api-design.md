# Stage: api-design

Decides with the user whether the workstream adds or changes API contracts; if so, agrees the contract, writes the
repo API document in the workstream worktree (committed on branch `<slug>`, never on `main`), and ends with an
approved `API Design` note. Notation: `<projectNoteId>` = `factory.projectNoteId`; `<Factory Log>` = its child titled
`Factory Log`; `<slug>` = the `--workstream` value, else live `factory-config get activeWorkstream --repo
"<repoPath>"` (never the preflight snapshot: brainstorm may have changed it); `<ws>` = its note id; `<docs>` =
`<repoPath>/.factory/workstreams/<slug>/docs`; `<wt>` = `<repoPath>/.factory/worktrees/<slug>`; `<ISO ts>` =
`date -u +%Y-%m-%dT%H:%M:%SZ`. Every write follows `$PLUGIN_ROOT/skills/run/references/trilium-schema.md`.

- **Free-text question**: AskUserQuestion with the options named; the user types the answer via Other.
- **Write `<Title>` under `<parent>`**: `mcp__trilium__get_child_notes(<parent>)`, exact title: found →
  `mcp__trilium__set_note_content(<noteId>, …)`; absent → `mcp__trilium__create_note` (parent, title, type `text`,
  Markdown content). Then one `mcp__trilium__set_attribute` per label named.
- **Export `<kind>`**: `mcp__trilium__get_note_content(<noteId>)` → Write `<docs>/<kind>.md`.
- **Log**: `mcp__trilium__append_to_note(<Factory Log>, "- <ISO ts> [api-design] <event>")`.
- **Drafts first.** Until `Approve` in step 7, write only `<draft>` = `<docs>/api-design-draft.md` and `<repoDraft>`
  = `<repoPath>/.factory/workstreams/<slug>/api-draft/<apiDocPath>`; Trilium (the Standards' `#apiDocPath`
  included), `<docs>/api-design.md` and `<wt>` stay as they are.
- **Stop api-design** (a `Stop` answer or a stop below):
  `rm -rf "<draft>" "<repoPath>/.factory/workstreams/<slug>/api-draft"`; Log `stage stopped — <reason>`;
  `factory-event stage --stage api-design --status stopped --workstream <slug> </dev/null`; leave `#stageApi` unchanged.

## Prerequisites

1. No `<slug>` → refuse `No active workstream: run /factory:brainstorm first.` and stop. `<ws>` =
   `factory-config get workstreams.<slug>.noteId --repo "<repoPath>"`; on a miss
   `mcp__trilium__search_notes("#factoryWorkstream #slug='<slug>' #project='<repoName>'")` and cache it with
   `factory-config set workstreams.<slug>.noteId <ws> --repo "<repoPath>"`.
2. `mcp__trilium__get_attributes(<ws>)` shows `#stageBrainstorm=done`. Else refuse `Missing #stageBrainstorm=done on
   workstream <slug>: run /factory:brainstorm first.` and stop. `<planRev>` = its `#planRev`.
3. `factory-event stage --stage api-design --status started --workstream <slug> </dev/null`.
4. `#stageApi` is `done` or `skipped` → Direct-command behaviour below before step 1.

## Procedure

1. **Applicability.** `mcp__trilium__get_child_notes(<ws>)`: Export `spec` and `plan` from `Spec` and `Plan`; copy
   `<repoPath>/.factory/docs/standards.md` into `<docs>/`. Read them. API work = an HTTP, RPC, GraphQL, webhook or
   event contract that this workstream adds or changes. AskUserQuestion "This plan appears to <involve / not involve>
   API contracts (<one-line evidence>). Run the API design stage?" options `Yes` / `Skip` (matching option first).
   - Skip → `mcp__trilium__set_attribute(<ws>, stageApi=skipped)`; Log `stage skipped — user chose Skip
     (<evidence>)`; `factory-event stage --stage api-design --status done --workstream <slug> </dev/null`; the stage
     ends here. On a re-run with `#stageApi=done`, Skip leaves `done`, `API Design` and the repo document unchanged:
     Log `re-run skipped, earlier API Design kept` and send the same event instead.
2. **Existing API** (brownfield, `#projectKind=brownfield` on `<projectNoteId>`). Graph first (SOP 5):
   `cd "<repoPath>" && graphify query "Which API endpoints, routes, schemas and API documents exist?"`; summarise in
   ≤ 100 words for `{{changes}}`. Greenfield → `n/a (new API)`.
3. **Questions** (at most 3 AskUserQuestion calls):
   - Contract style: the Standards' choice first, marked `(Standards)`, then up to 3 of `OpenAPI 3.1 (REST)`,
     `AsyncAPI 3 (events)`, `gRPC (protobuf)`, `GraphQL SDL`, `None (no external contract)`.
   - Resources and operations: Free-text question listing the operations you derive from the Spec, one line each
     (`POST /v1/sessions — log in`, or the rpc / query name): "Are these the operations?" options
     `Use as proposed` / `Stop`; changes via Other.
   - Auth and errors (one call, two questions): authentication (`Bearer token (JWT)`, `Session cookie`, `API key`,
     `None`; the Standards' or existing scheme first) and error format (`RFC 9457 problem+json`,
     `Existing error shape`).
   - `None (no external contract)` → no repo document: `<apiDocPath>` empty; skip steps 4–5.
4. **Repo document path.** `mcp__trilium__get_child_notes(<projectNoteId>)`, exact title `Standards` →
   `<standardsId>`; `mcp__trilium__get_attributes(<standardsId>)`: `#apiDocPath` set → `<apiDocPath>`. Else propose
   the location the Standards' API documentation section names, else `openapi/openapi.yaml` (AsyncAPI
   `asyncapi/asyncapi.yaml`, gRPC `proto/<service>.proto`, GraphQL `schema.graphql`): AskUserQuestion
   `Use <path> / Stop` (another repo-relative path via Other; no `..`, no absolute path); `<newPath>` = yes (it is
   stored on Standards at Approve so every workstream uses the same document).
5. **Draft the repo document** (SOP 4 and 8: the worktree is only read here).
   - `factory-worktree ensure <slug> --repo "<repoPath>"` → `path` = `<wt>`. Exit 2 → AskUserQuestion
     `Adopt branch <slug> / Stop`; Adopt → rerun with `--adopt`. Exit 1 or 3 → show `error`; Stop api-design.
     `git -C "<wt>" branch --show-current` must print `<slug>`; else Stop api-design. Never write under `<repoPath>`
     outside `.factory/`: that tree is `main`.
   - Write `<repoDraft>` = the current `<wt>/<apiDocPath>` (if it exists) with this workstream's operations,
     schemas, security schemes and error responses added or changed, the rest as is (valid OpenAPI 3.1 or AsyncAPI 3
     YAML, proto3, or GraphQL SDL).
   - Self-check: every operation agreed in step 3 is in the draft with its auth and error responses.
6. **Draft API Design.** Read `$PLUGIN_ROOT/skills/run/templates/api-design.md`; fill `{{slug}}`, `{{plan_rev}}`
   (`<planRev>`), `{{api_doc_path}}` (`<apiDocPath>`, or `n/a`), `{{applicability}}` (step 1 evidence and answer),
   `{{style}}`, `{{endpoint_rows}}` (one `| <METHOD> | <path> | <request> | <response> | <errors> | <auth> |` row per
   operation; rpc or GraphQL: the name in Method/Path), `{{models}}`, `{{auth}}`, `{{errors}}`, `{{versioning}}`
   (e.g. `/v1` prefix, additive changes only), `{{changes}}` (step 2: added, changed, removed), `{{examples}}` (one
   request and response per key operation); keep lines 1–2. Write it to `<draft>`.
7. **Approval.** Summarise from the drafts (style, operations, auth, error format, `<draft>`) and show
   `git diff --no-index -- "<wt>/<apiDocPath>" "<repoDraft>"` (`/dev/null` in place of a missing file).
   AskUserQuestion `Approve / Edit / Stop`.
   - Edit → the user's changes via Other; update both drafts; ask again. Stop → Stop api-design.
   - Approve, in this order:
     1. Repo document (none → skip): `mkdir -p "$(dirname "<wt>/<apiDocPath>")" && cp "<repoDraft>" "<wt>/<apiDocPath>"`;
        if `git -C "<wt>" status --porcelain -- "<apiDocPath>"` is non-empty:
        `git -C "<wt>" add -- "<apiDocPath>" && git -C "<wt>" commit -m "docs(api): <slug>" -- "<apiDocPath>"`;
        `<sha>` = `git -C "<wt>" rev-parse --short HEAD`.
     2. `<newPath>` → `mcp__trilium__set_attribute(<standardsId>, apiDocPath=<apiDocPath>)`.
     3. Write `API Design` under `<ws>` with the `<draft>` content; labels `#factoryDoc=api-design`,
        `#approval=approved`, `#apiDocPath=<apiDocPath>` (empty when none), `#project=<repoName>`,
        `#workstream=<slug>`. Export `api-design`; `rm -rf "<draft>" "<repoPath>/.factory/workstreams/<slug>/api-draft"`.
     4. Log `<slug> API Design approved, <apiDocPath> committed <sha> on <slug>` (or `unchanged`, or `no repo
        document`).

## Completion

1. `mcp__trilium__set_attribute(<ws>, stageApi=done)`.
2. Log `stage done — <slug>: <style>, <n> operations, <apiDocPath or no repo document>`.
3. `factory-event stage --stage api-design --status done --workstream <slug> </dev/null`.
4. Print one paragraph: style, operations, the repo document and commit, `<docs>/api-design.md`; next stage: plan.

## Direct-command behaviour

`/factory:api-design` or `/factory:run api-design [--workstream <slug>]` when `#stageApi` is `done` or `skipped`:
AskUserQuestion "api-design is already <done|skipped> for <slug>. Run it again?" options
`Re-run (update the API document and API Design)` / `Stop`.
- `Stop` → no writes; `factory-event stage --stage api-design --status stopped --workstream <slug> </dev/null`; stop.
- `Re-run` → steps 1–7 and Completion: the same repo document is updated (a new `docs(api): <slug>` commit, never an
  amend) and `API Design` overwritten. `#stageApi` keeps its value until Completion; `Skip` in step 1 never turns an
  earlier `done` into `skipped`. When `#stagePlan=done` on `<ws>`, end by telling the user to run `/factory:plan` so
  the tasks are realigned.

Entered with no verb (`/factory:run`), the stage runs only while `#stageApi` is unset and continues with plan after
Completion; entered as a direct command, stop after Completion.

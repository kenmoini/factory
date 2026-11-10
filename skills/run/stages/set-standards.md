# Stage: set-standards

Researches current tooling for the project's stack, agrees each standards area with the user and ends with an
approved `Standards` note. Its labels `#lintCmd`, `#testCmd`, `#buildCmd` and `#ciPlatform` are the factory's only
source for those values (SOP 3). `<projectNoteId>` = `factory.projectNoteId`; `<Factory Log>` = its child titled
`Factory Log` (`mcp__trilium__get_child_notes(<projectNoteId>)`); `<ISO ts>` = `date -u +%Y-%m-%dT%H:%M:%SZ`. Every
write follows `$PLUGIN_ROOT/skills/run/references/trilium-schema.md` (find or create, templates, Agent Run notes).

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
  `mcp__trilium__create_note` there: title `<ISO ts> standards-researcher pending`,
  content `Dispatched <ISO ts>. Brief: <first line>`, labels `#factoryAgentRun`,
  `#agentType=standards-researcher`, `#status=running`, `#startedAt=<ISO ts>`, `#project=<repoName>`. Agent call:
  `subagent_type: "factory:standards-researcher"`, foreground,
  `description: "standards-researcher set-standards [task:none]"`, `prompt` = the five-line brief. After
  it: `mcp__trilium__rename_note` to `<ISO ts> standards-researcher <agentId>`; set `#agentId=<agentId>`,
  `#status=done` (contract parsed) or `failed`, `#endedAt=<ISO ts>`; `mcp__trilium__append_to_note` the summary
  lines and the json block. Contract keys: `report_path`, `recommendations` (each `area`, `choice`, `version`,
  `why`). None parses or the call errors → `failed`, dispatch once more (new run note); a second failure → tell
  the user the agent's message and Stop set-standards.
- **Stop set-standards** (a `Stop` answer or a second agent failure):
  `mcp__trilium__append_to_note(<Factory Log>, "- <ISO ts> [set-standards] stage stopped — <reason>")`;
  `factory-event stage --stage set-standards --status stopped </dev/null`; leave `#stageStandards` unchanged; end.

## Prerequisites

1. `mcp__trilium__get_attributes(<projectNoteId>)` shows `#stageExamine=done` (keep `#projectKind`). Else refuse
   `Missing #stageExamine=done on project <repoName>: run /factory:examine first.` and stop.
2. `Goal` (exact title under `<projectNoteId>`): `mcp__trilium__get_attributes(<goalNoteId>)` shows
   `#approval=approved`. Else refuse `Missing #approval=approved on note Goal: run /factory:examine first.` and stop.
3. `#stageStandards=done` on the project → Direct-command behaviour below before step 1.

## Procedure

1. **Inputs on disk.** `<repoPath>/.factory/docs/goal.md` missing → export `Goal` (Export rule). Researcher input:
   - brownfield: `examination=<repoPath>/.factory/examine/report.md`; missing →
     `examination=<repoPath>/.factory/docs/examination.md` (export `Codebase Examination` first if absent).
   - greenfield: `answers=<repoPath>/.factory/research/answers.md`; missing →
     `answers=<repoPath>/.factory/docs/goal.md`.
2. **Research** (`standards-researcher`). `mkdir -p "<repoPath>/.factory/research"`; Write
   `<repoPath>/.factory/research/questions.md` (overwrite; the agent reads only its brief's files, so this file
   carries the context): `Stack:` the Goal's Technologies table (one line each); `Constraints:` the Goal's
   Constraints and Out of scope (one line each); "Give one recommendation per area (`runtime`, `lint`, `test`,
   `build`, `api-docs`, `ci`, `artifacts`, `pipelines`, `public-docs`, `other`) with its current stable version
   verified on the web, and one or two alternatives per area in the report." Then these questions:
   - current stable versions of the runtimes, languages and frameworks (brownfield: the detected ones; flag
     end-of-life versions);
   - recommended lint, format, test and build tools for this stack, with their exact commands;
   - CI conventions: a local `Makefile` plus GitHub Actions, and GitLab CI as the alternative;
   - packaging norms: container image (Containerfile, base image), standalone binary, Helm chart, package registry;
   - API documentation formats that fit (OpenAPI 3.1, AsyncAPI, GraphQL SDL, protobuf);
   - public docs-site options (plain Markdown in `docs/`, MkDocs Material, Docusaurus, Starlight);
   - dependency update tooling (Dependabot or Renovate).

   Dispatch with:

   ```
   Task: Research current standards and tooling for <repoName> [task:none]
   Read first: <repoPath>/.factory/research/questions.md
   Inputs: <the examination= or answers= input from step 1>
   Write: <repoPath>/.factory/research/**
   Return: ≤15 lines then exactly one fenced json block matching your contract
   ```

   Read the report at `report_path`; keep the recommendations by area.
3. **Dialogue**: seven questions in at most four AskUserQuestion calls (A: Q1; B: Q2 + Q3; C: Q4 + Q5; D: Q6 + Q7).
   Options: at most four, concrete, with the version the research verified (`version` "" → no version). Brownfield
   puts the choice detected in `Codebase Examination` first, labelled `(current)`; the research recommendation is
   labelled `(recommended)`. Any other answer comes via Other.

   | Q | Area → Standards section | Options |
   |---|---|---|
   | 1 | Runtime, versions, lint/test/build tools → `runtimes`, `style`, `testing` | brownfield: the current stack `(current)`; the research `runtime` + `lint` + `test` + `build` choices `(recommended)`; one or two alternatives from the report |
   | 2 | API documentation → `api_docs` | `OpenAPI 3.1 (docs/openapi.yaml)`, `AsyncAPI 3`, `GraphQL SDL or .proto files`, `No API` |
   | 3 | CI platform → `pipelines` | `Makefile + GitHub Actions (default)`, `Makefile + GitLab CI`, `Makefile only, no hosted CI`, `None yet` |
   | 4 | Build artifacts (multiSelect) → `artifacts` | `Container image (Containerfile)`, `Standalone binary`, `Helm chart`, `Package for a registry` (none: via Other) |
   | 5 | Pipelines (multiSelect) → `pipelines`, `dependencies` | `PR checks: lint, test, build`, `Dependency updates (<Dependabot or Renovate, per research>)`, `Release on tag`, `Publish image or chart to a registry` |
   | 6 | Public docs → `public_docs` | `Markdown in docs/ (no site)`, the research `public-docs` choice, one alternative, `None` |
   | 7 | Other traits (free text) → `other` | `Nothing else` / `Stop`; via Other: code style, commit convention, licence, branching, security tooling, coverage |

   `Stop` → Stop set-standards.
4. **Machine values** (decided here, shown in step 6):
   - `ciPlatform`: GitHub Actions → `github-actions`; GitLab CI → `gitlab-ci`; `Makefile only, no hosted CI` or
     `None yet` → `none`; another platform via Other → its lowercase hyphenated name.
   - `lintCmd`, `testCmd`, `buildCmd`: Q3 includes a Makefile → `make lint`, `make test`, `make build` for each
     target whose tool Q1 names (enforce-standards writes the targets); no Makefile → the tool's own command from
     Q1 (brownfield: the repo's existing script, e.g. `npm run lint`). No tool named, or the user said "none yet"
     → empty string. Never invent a command (SOP 3).
5. **Write `Standards`** (template `standards.md`; labels `#factoryDoc=standards`, `#project=<repoName>`,
   `#approval=pending`, `#lintCmd=<lintCmd>`, `#testCmd=<testCmd>`, `#buildCmd=<buildCmd>`,
   `#ciPlatform=<ciPlatform>`, an empty value allowed; export kind `standards`). Fill: `repo_name`; `approved_at` =
   `pending`; `research_report_path`; `lint_cmd`, `test_cmd`, `build_cmd`, `ci_platform` (`none` in the body when
   empty); one section per area from the answers, with exact tool names, versions and file paths; `dependencies`
   = the update tool and cadence from Q5; `other` = Q7; `decision_rows` = one row per area
   `| <area> | <choice> | <version or –> | <why> | <other options offered> |`.
6. **Approve the Standards** (human gate). Print at most 200 words: area → choice and version, and the four machine
   values. AskUserQuestion "Approve these Standards?" — options `Approve` / `Edit (tell me what to change)` / `Stop`.
   - `Approve` → `mcp__trilium__set_attribute(<standardsNoteId>, approval=approved)`;
     `mcp__trilium__append_to_note(<Factory Log>, "- <ISO ts> [set-standards] standards approved")`;
     `mcp__trilium__edit_note_content(<standardsNoteId>)` replacing `**Approved:** pending` with
     `**Approved:** <ISO ts>`; re-export; go to Completion.
   - `Edit` → the change is the Other text (option picked without text → free-text question "What should change?",
     options `Nothing, ask again` / `Stop`); rewrite the content with `mcp__trilium__set_note_content` and re-set
     any changed machine label with `mcp__trilium__set_attribute`; re-export; ask again.
   - `Stop` → `#approval` stays `pending`; Stop set-standards.

## Completion

1. `mcp__trilium__set_attribute(<projectNoteId>, stageStandards=done)`.
2. `mcp__trilium__append_to_note(<Factory Log>,`
   `"- <ISO ts> [set-standards] stage done — ci <ciPlatform>, lint <lintCmd|none>, test <testCmd|none>, build <buildCmd|none>")`.
3. `factory-event stage --stage set-standards --status done </dev/null`.
4. Print one paragraph: the Standards note id, the four machine values, the export
   `<repoPath>/.factory/docs/standards.md`; next stage: enforce-standards.

Exports: project documents live at `<repoPath>/.factory/docs/<kind>.md`; workstream stages copy them into
`<repoPath>/.factory/workstreams/<slug>/docs/`, and the Export loop above refreshes those copies on a re-run.

## Direct-command behaviour

`/factory:set-standards` or `/factory:run set-standards` when `#stageStandards=done`: AskUserQuestion
"set-standards is already done (Standards <standardsNoteId>). Run it again?" — options
`Re-run (overwrite the document, keep labels)` / `Stop`.
- `Stop` → no writes; `factory-event stage --stage set-standards --status done </dev/null`; stop.
- `Re-run` → steps 1–6 and Completion. `Standards` is overwritten in place (same note id); `#stageStandards` stays
  `done`; step 5 re-sets the machine labels to the new values and `#approval` follows steps 5–6. When
  `#stageEnforce` is set, tell the user to re-run `/factory:enforce-standards` so the scaffolding matches.

Entered with no verb (`/factory:run`), the stage runs only while `#stageStandards` is unset and continues with
enforce-standards after Completion; entered as a direct command, stop after Completion.

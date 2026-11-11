# Stage: set-standards

Researches current tooling for the project's stack, agrees each standards area with the user and ends with an
approved `Standards` note. Its labels `#lintCmd`, `#testCmd`, `#buildCmd` and `#ciPlatform` are the factory's only
source for those values (SOP 3). `<projectNoteId>` = `factory.projectNoteId`; `<Factory Log>` = its child titled
`Factory Log` (`mcp__trilium__get_child_notes(<projectNoteId>)`); `<ISO ts>` = `date -u +%Y-%m-%dT%H:%M:%SZ`. Every
write follows `$PLUGIN_ROOT/skills/run/references/trilium-schema.md` (find or create, templates, Agent Run notes).

- **Free-text question**: AskUserQuestion with the options named; the user types the answer via Other. Keep answers
  verbatim; never invent one.
- **Drafts first.** The Standards are filled into `<repoPath>/.factory/research/draft-standards.md` and shown from
  there. The `Standards` note, its labels and the exports change only in step 6's `Approve` branch, so a `Stop`
  (also during a re-run) leaves Trilium and `<repoPath>/.factory/docs/` exactly as they were.
- **Export** `<kind>` from `<noteId>`: `mcp__trilium__get_note_content(<noteId>)` → Write
  `<repoPath>/.factory/docs/<kind>.md`, then refresh workstream copies (safe when there are none, in bash or zsh):
  `find "<repoPath>/.factory/workstreams" -mindepth 2 -maxdepth 2 -type d -name docs -exec cp "<repoPath>/.factory/docs/<kind>.md" {} \; 2>/dev/null; true`.
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
  `factory-event stage --stage set-standards --status stopped </dev/null`; leave `#stageStandards`, the `Standards`
  note, its labels and the exports unchanged (the draft stays); end the run.

## Prerequisites

1. `mcp__trilium__get_attributes(<projectNoteId>)` shows `#stageExamine=done` (keep `#projectKind`). Else refuse
   `Missing #stageExamine=done on project <repoName>: run /factory:examine first.` and stop.
2. `Goal` (exact title under `<projectNoteId>`): `mcp__trilium__get_attributes(<goalNoteId>)` shows
   `#approval=approved`. Else refuse `Missing #approval=approved on note Goal: run /factory:examine first.` and stop.
3. `#stageStandards=done` on the project → Direct-command behaviour below before step 1.

## Procedure

1. **Inputs on disk.** `<repoPath>/.factory/docs/goal.md` missing → export kind `goal` from the Goal note.
   Researcher input:
   - brownfield: `examination=<repoPath>/.factory/examine/report.md`; missing →
     `examination=<repoPath>/.factory/docs/examination.md` (export kind `examination` from `Codebase Examination`
     first if absent).
   - greenfield: `answers=<repoPath>/.factory/research/answers.md`; missing →
     `answers=<repoPath>/.factory/docs/goal.md`.
2. **Research** (`standards-researcher`). `mkdir -p "<repoPath>/.factory/research"`; Write
   `<repoPath>/.factory/research/questions.md` (overwrite; the agent reads only its brief's files, so this file
   carries the context): `Stack:` the Goal's Technologies table (one line each); `Constraints:` the Goal's
   Constraints and Out of scope (one line each); "Give one recommendation per area (`runtime`, `lint`, `test`,
   `build`, `api-docs`, `ci`, `artifacts`, `pipelines`, `public-docs`, `release`, `hooks`, `security`,
   `supply-chain`, `coverage`, `dev-env`) with its current stable version verified on the web, and one or two
   alternatives per area in the report." Then these questions:
   - current stable versions of the runtimes, languages and frameworks (brownfield: the detected ones; flag
     end-of-life versions);
   - recommended lint, format, test and build tools for this stack, with their exact commands;
   - CI conventions: a local `Makefile` plus GitHub Actions, and GitLab CI as the alternative;
   - packaging norms: container image (Containerfile, base image), standalone binary, Helm chart, package registry;
   - API documentation formats that fit (OpenAPI 3.1, AsyncAPI, GraphQL SDL, protobuf);
   - public docs-site options (plain Markdown in `docs/`, MkDocs Material, Docusaurus, Starlight);
   - dependency update tooling (Dependabot or Renovate);
   - release automation that fits the stack (release-please, semantic-release, changesets, goreleaser, …) and the
     commit-message check for Conventional Commits;
   - git-hook manager (husky + lint-staged, lefthook, pre-commit) and the stack's coverage tool;
   - security scanners for the stack: SAST (CodeQL or Semgrep), secret scanning (gitleaks), dependency
     vulnerabilities (osv-scanner or the ecosystem's audit command), image scanning (Trivy);
   - supply-chain tooling: frozen installs from the lockfile, SBOM (syft), signing and provenance (cosign, GitHub
     artifact attestations);
   - toolchain pinning and dev environments (mise, .tool-versions, devcontainer, Nix or devbox).

   Dispatch with:

   ```
   Task: Research current standards and tooling for <repoName> [task:none]
   Read first: <repoPath>/.factory/research/questions.md
   Inputs: <the examination= or answers= input from step 1>
   Write: <repoPath>/.factory/research/**
   Return: ≤15 lines then exactly one fenced json block matching your contract
   ```

   Read the report at `report_path`; keep the recommendations by area.
3. **Dialogue**: Read `$PLUGIN_ROOT/skills/run/references/standards-traits.md`: sixteen questions (Q1–Q6 stack,
   API docs, CI, artifacts, pipelines, public docs; Q7–Q16 the maturity traits: licence, releases, git hooks,
   security scanning, supply chain, test policy, repository files, developer environment, architecture decisions,
   runtime operations), each with a header, options as label + description, the Standards section it fills and
   its research area. Ask them in five AskUserQuestion calls (A: Q1; B: Q2–Q5; C: Q6–Q9; D: Q10–Q13; E: Q14–Q16);
   skip Q16 when the reference's applicability rule says so (section `n/a (not a service)`); call A's preamble
   says once that `Stop` typed via Other on any question stops the stage. There is no free-text catch-all
   question: anything beyond the listed options comes via Other on the question it belongs to.
   **Option rule** (every question; AskUserQuestion allows at most four options): start from the listed options.
   Take the brownfield choice detected in `Codebase Examination` (Maturity table for Q1, Q3, Q6; the Traits row
   named in the reference for Q7–Q16, none when the examination has no Traits table; a Detected value of `none`
   labels the question's `None …`/`No …`/`README only` option when it has one and otherwise adds nothing; label
   `(current)`) and the
   research recommendation for the question's research area (label `(recommended)`; the verified version goes
   into the description). Single-select questions: each one that matches a listed option gets its label added;
   each one that does not: with fewer than four options listed it is added as a new option; only when four are
   listed does it replace the last listed option that has no label (a `None …`/`No …`/`README only` option is never
   replaced). MultiSelect questions: a recommendation or current choice labels every option it covers and fills
   that option's `<tool>`; it never adds or replaces an option. Order: `(current)` first, then `(recommended)`,
   then the rest; one choice that is both gets `(current, recommended)`. Any other answer comes via Other;
   `Stop` typed via Other on any question → Stop set-standards.
4. **Machine values** (shown in step 6):
   - `ciPlatform`: `GitHub Actions` → `github-actions`; `GitLab CI` → `gitlab-ci`; `Makefile only` or `None yet` →
     `none`; another platform via Other → its lowercase hyphenated name.
   - `lint`, `test`, `build` tool commands: the tool's own command from Q1 (brownfield: the repo's existing script,
     e.g. `npm run lint`), never `make …`. No tool named, or the user said "none yet" → empty string. Never
     invent a command (SOP 3). `#lintCmd`, `#testCmd`, `#buildCmd` get these tool commands; when Q3 is anything but
     `None yet` (every other option carries a Makefile), enforce-standards re-points them to `make lint|test|build`
     after it has committed those targets.
   - `postMergeSmoke`: `true` only when the user opted in (Q5 via Other); else `false` (the default: builders
     already run the tests in the worktree, and `<main>` may lack installed dependencies).
5. **Draft `Standards`**: Read template `standards.md`, fill every `{{placeholder}}` (`n/a` when not applicable),
   keep lines 1–2, Write `<repoPath>/.factory/research/draft-standards.md`. Fill: `repo_name`; `approved_at` =
   `pending`; `research_report_path`; `lint_cmd`, `test_cmd`, `build_cmd`, `ci_platform`, `post_merge_smoke` = the
   step 4 values (`none` in the body when empty); one section per area from the answers, with exact tool names, versions and
   file paths; `style` ends with the line `lint: <tool command or none>`, `testing` with `test: <…>`, `artifacts`
   with `build: <…>` (the source enforce-standards uses for Makefile targets); `pipelines` states whether a local
   `Makefile` with targets lint, test, build is wanted (Q3: any option but `None yet`); `dependencies` = the update
   tool and cadence from Q5;
   the trait placeholders (`licence`, `releases`, `hooks`, `security`, `supply_chain`, `test_policy`, `repo_files`,
   `dev_env`, `decisions_docs`, `operations`) = the Q7–Q16 answers with the exact tools, files and thresholds the
   reference's Scaffolding lines name, each chosen option keeping its `(builders apply)` or `(plan applies)` tag
   from the reference (`n/a (not a service)` for a skipped Q16); `decision_rows` = one row per area
   `| <area> | <choice> | <version or –> | <why> | <other options offered> |`.
6. **Approve the Standards** (human gate). From the draft, print a table of area → choice (and version), one row
   per section, then the machine values (with a Makefile: "enforce-standards will point the commands at `make`
   targets") and the
   draft path. AskUserQuestion "Approve these Standards?" — options `Approve` / `Edit (tell me what to change)` /
   `Stop`.
   - `Approve`, in this order:
     `mcp__trilium__append_to_note(<Factory Log>, "- <ISO ts> [set-standards] standards approved")`; in the draft
     replace `**Approved:** pending` with `**Approved:** <ISO ts>`; `mcp__trilium__get_child_notes(<projectNoteId>)`,
     exact title `Standards`: found → `mcp__trilium__set_note_content(<standardsNoteId>, <draft content>)`; absent →
     `mcp__trilium__create_note` (parent `<projectNoteId>`, title `Standards`, type `text`, the draft content); then
     one `mcp__trilium__set_attribute` each: `#factoryDoc=standards`, `#project=<repoName>`, `#approval=approved`,
     `#lintCmd=<lint>`, `#testCmd=<test>`, `#buildCmd=<build>`, `#ciPlatform=<ciPlatform>` (empty values allowed),
     `#postMergeSmoke=<postMergeSmoke>`;
     export kind `standards`; go to Completion.
   - `Edit` → the change is the Other text (option picked without text → free-text question "What should change?",
     options `Nothing, ask again` / `Stop`); rewrite the draft (and the step 4 values it changes), print the summary
     again, ask again. Trilium is not touched.
   - `Stop` → Stop set-standards.

## Completion

1. `mcp__trilium__set_attribute(<projectNoteId>, stageStandards=done)`.
2. `mcp__trilium__append_to_note(<Factory Log>,`
   `"- <ISO ts> [set-standards] stage done — ci <ciPlatform>, lint <lintCmd|none>, test <testCmd|none>, build <buildCmd|none>")`.
3. `factory-event stage --stage set-standards --status done </dev/null`.
4. Print one paragraph: the Standards note id, the machine values, the export
   `<repoPath>/.factory/docs/standards.md`; next stage: enforce-standards.

Exports: project documents live at `<repoPath>/.factory/docs/<kind>.md`, written only from approved notes;
workstream stages copy them into `<repoPath>/.factory/workstreams/<slug>/docs/`, and the export's `find` command
refreshes those copies whenever an approved document changes.

## Direct-command behaviour

`/factory:set-standards` or `/factory:run set-standards` when `#stageStandards=done`: AskUserQuestion
"set-standards is already done (Standards <standardsNoteId>). Run it again?" — options
`Re-run (overwrite the document, keep labels)` / `Stop`.
- `Stop` → no writes; `factory-event stage --stage set-standards --status stopped </dev/null`; stop.
- `Re-run` → steps 1–6 and Completion. Until `Approve`, the approved `Standards`, its labels and the exports stay
  as they are (a `Stop` changes none of them); on `Approve` the note is overwritten in place (same note id) and its
  machine labels get the new tool commands. `#stageStandards` stays `done` throughout. When `#stageEnforce` is set,
  tell the user to re-run `/factory:enforce-standards` so the scaffolding matches and the labels point at the
  Makefile again.

Entered with no verb (`/factory:run`), the stage runs only while `#stageStandards` is unset and continues with
enforce-standards after Completion; entered as a direct command, stop after Completion.

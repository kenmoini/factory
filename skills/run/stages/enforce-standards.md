# Stage: enforce-standards

Turns the approved `Standards` into repository scaffolding: compares what they call for with `<repoPath>`, writes
an `Enforcement Plan`, and only once the user approves it writes the files, runs lint and tests and makes the one
scaffolding commit on `main` that SOP 4 allows (`chore: enforce standards`). `<projectNoteId>` =
`factory.projectNoteId`; `<Factory Log>` = its child titled `Factory Log`
(`mcp__trilium__get_child_notes(<projectNoteId>)`); `<ISO ts>` = `date -u +%Y-%m-%dT%H:%M:%SZ`. Every write follows
`$PLUGIN_ROOT/skills/run/references/trilium-schema.md` (find or create, templates).

- **Safety.** Until the plan is approved, write only under `<repoPath>/.factory/enforce/`; afterwards only the
  plan's paths. Delete only files the approved plan lists with action `delete`. Commit only the plan's paths, only
  on `main`; never push.
- **Free-text question**: AskUserQuestion with the options named; the user types the answer via Other.
- **Write `Enforcement Plan`** (template `$PLUGIN_ROOT/skills/run/templates/enforcement-plan.md`): Read it, fill every
  `{{placeholder}}` (`n/a` when not applicable), keep lines 1–2. `mcp__trilium__get_child_notes(<projectNoteId>)`,
  exact title `Enforcement Plan`: found → `mcp__trilium__set_note_content(<planNoteId>, …)`; absent →
  `mcp__trilium__create_note` (parent `<projectNoteId>`, title `Enforcement Plan`, type `text`, the content). Then
  `mcp__trilium__set_attribute` for `#factoryDoc=enforcement-plan`, `#project=<repoName>`, `#approval=pending`.
- **Export** after every write or edit of the plan: `mcp__trilium__get_note_content(<planNoteId>)` → Write
  `<repoPath>/.factory/docs/enforcement-plan.md`.
- **Stopped** (a `Stop` answer or a failed check below):
  `mcp__trilium__append_to_note(<Factory Log>, "- <ISO ts> [enforce-standards] stage stopped — <reason>")`;
  `factory-event stage --stage enforce-standards --status stopped </dev/null`; leave `#stageEnforce` unchanged;
  tell the user which plan files are in the working tree uncommitted (a re-run commits them); end the run.

## Prerequisites

1. `mcp__trilium__get_attributes(<projectNoteId>)` shows `#stageStandards=done`. Else refuse
   `Missing #stageStandards=done on project <repoName>: run /factory:set-standards first.` and stop.
2. `Standards` (exact title under `<projectNoteId>`): `mcp__trilium__get_attributes(<standardsNoteId>)` shows
   `#approval=approved`. Else refuse `Missing #approval=approved on note Standards: run /factory:set-standards first.`
   and stop. Keep `#lintCmd`, `#testCmd`, `#buildCmd`, `#ciPlatform` (absent = empty). Missing
   `<repoPath>/.factory/docs/standards.md` → `mcp__trilium__get_note_content(<standardsNoteId>)` → Write it.
3. `git -C "<repoPath>" branch --show-current` is `main` (`master` when the repo has no `main`). Else refuse
   `enforce-standards commits on main: switch <repoPath> to main, then re-run /factory:enforce-standards.` and stop.
4. `#stageEnforce` is `done` or `skipped` on the project → Direct-command behaviour below before step 1.

## Procedure

1. **Inventory.** Read `<repoPath>/.factory/docs/standards.md`. One row per item; Desired comes only from the
   Standards, Present from checks run in `<repoPath>`:
   - `.gitignore`: `.factory/`, `graphify-out/`, `.env`, and the dependency and build directories of the Standards'
     stack (e.g. `node_modules/`, `dist/`, `.venv/`); present = `grep -qxF '<entry>' .gitignore` per entry.
   - `Makefile`: targets `lint`, `test`, `build` for each command label that starts with `make `; present =
     `grep -qE '^<target>:' Makefile`.
   - CI workflow for `#ciPlatform`: `github-actions` → `.github/workflows/ci.yml`, `gitlab-ci` → `.gitlab-ci.yml`,
     `none` → not chosen; present = a workflow file of that platform runs the lint, test and build commands.
   - Dependency updates (Standards "Dependencies and updates"): Dependabot → `.github/dependabot.yml`;
     Renovate → `renovate.json`.
   - Container image, if an artifact: `Containerfile` (an existing `Dockerfile` counts as present) and
     `.containerignore`.
   - Helm chart, if an artifact: `charts/<repoName>/` with `Chart.yaml`, `values.yaml`, `templates/`.
   - Docs site, if the public docs format is a site generator: its config (e.g. `mkdocs.yml`) and `docs/index.md`.
   - `README.md` sections `## Overview`, `## Getting started`, `## Development` (the three commands), `## CI`,
     `## License`; present = `grep -qxF '## <Section>' README.md` per section.
   - License: `LICENSE` with the licence the Standards name; none named → Desired `not chosen` (never pick one).

   Action (the template's column): `create` (missing), `update` (incomplete: add only what is missing, keep the
   rest), `keep` (complete, or not chosen). A complete file shown by `git -C "<repoPath>" status --porcelain` gets
   `update` (Desired: commit it). Replacing a file (e.g. an old CI config) needs its own `delete` row.
   That status listing paths outside these rows → Stopped (`main has unrelated changes: <paths>`).
2. **Draft.** `rm -rf "<repoPath>/.factory/enforce" && mkdir -p "<repoPath>/.factory/enforce/files"`. For every
   `create` and `update` row Write the complete resulting file to `<repoPath>/.factory/enforce/files/<path>` (an
   update = the current file plus the additions). Content comes only from the Standards:
   - `Makefile`: `.PHONY: lint test build`; each target runs the tool command the Standards name; a target with no
     named tool prints `<target>: not configured (see Standards)`, and the plan lists it under Risks.
   - CI: on push and pull request to `main`, set up the Standards' runtimes, then run lint, test and build.
   - Dependabot or Renovate: the stack's package ecosystem plus the CI platform's actions, weekly.
   - `Containerfile`: multi-stage, the Standards' base image and version, non-root user.
   - Helm: minimal chart (`apiVersion: v2`, deployment, service, values for image and port).
   - Docs site: minimal config plus `docs/index.md` with the project name and the Goal's first line.
   - `README.md`: only the missing sections, using the Standards' commands.
   - `LICENSE`: the named licence's standard text, current year, holder from the Standards, else
     `git config user.name`.
3. **Write `Enforcement Plan`**, export it. Fill: `repo_name`; `standards_approved_at` from the `**Approved:**`
   line of `standards.md`; `approval` = `pending`; `summary` = counts per action; `gap_rows` = one row per inventory
   item `| <item> | <yes, no or partial: detail> | <desired> | <action> |`; `file_list` = one bullet per `create`,
   `update` or `delete` path with what it contains or what changes, then `Drafts: <repoPath>/.factory/enforce/files/`;
   `lint_cmd`, `test_cmd`, `build_cmd` (`none` when empty); `applied_sha` = `pending`; `risks` (updated existing
   files, placeholder targets, licence not chosen, …); `decision` = `pending`.
4. **Gate** (SOP 6). Print the gap table, the file list and, for each `update`,
   `git diff --no-index -- "<repoPath>/<path>" "<repoPath>/.factory/enforce/files/<path>"`. No `create`, `update` or
   `delete` row → say "nothing to enforce". AskUserQuestion "Apply this Enforcement Plan to <repoPath> and commit it
   on main?" — options `Approve` / `Edit (tell me what to change)` / `Skip stage`.
   - `Edit` → the change is the Other text (option picked without text → free-text question "What should change?",
     options `Nothing, ask again` / `Stop`); redo steps 1–3 for the affected rows (drafts, then the note with
     `mcp__trilium__set_note_content`; `#approval` stays `pending`); re-export; ask again.
   - `Skip stage` → `mcp__trilium__set_attribute(<planNoteId>, approval=rejected)`;
     `mcp__trilium__append_to_note(<Factory Log>, "- <ISO ts> [enforce-standards] plan rejected — stage skipped")`;
     `mcp__trilium__edit_note_content(<planNoteId>)`: `**Status:** pending` → `**Status:** rejected`, Decision
     `pending` → `Skipped by the user <ISO ts>`; re-export; go to Completion (skipped). The repo is untouched.
   - `Approve` → `mcp__trilium__set_attribute(<planNoteId>, approval=approved)`;
     `mcp__trilium__append_to_note(<Factory Log>, "- <ISO ts> [enforce-standards] plan approved")`. Nothing to
     enforce → `mcp__trilium__edit_note_content`: Status `approved`, Decision `Approved <ISO ts>; nothing to apply`;
     re-export; no `#appliedSha`; go to Completion. Else steps 5–7.
5. **Apply.** Repeat step 1's unrelated-changes check (fails → Stopped). Each `create`/`update` path:
   `mkdir -p "$(dirname "<repoPath>/<path>")" && cp "<repoPath>/.factory/enforce/files/<path>" "<repoPath>/<path>"`;
   each `delete` row: `git -C "<repoPath>" rm -q -- "<path>"`. Nothing else.
6. **Verify** `#lintCmd`, then `#testCmd` (empty → `none`, skip). Run with Bash timeout 600000:
   `cd "<repoPath>" && ( <cmd> ) > "<repoPath>/.factory/enforce/<lint|test>.log" 2>&1; echo "exit=$?"`.
   - Result: exit 0 → `ok`; non-zero and
     `grep -qiE 'no tests? (found|ran|to run)|no test files|collected 0 items|no (input )?files (were )?(found|matched)' <log>`
     → `no tests yet` (tolerated); otherwise `failed`.
   - `mcp__trilium__append_to_note(<planNoteId>, …)` a `## Result` section: `Applied <ISO ts>`, one line per command
     `- Lint <cmd>: exit <n> — <result>` (same for Test), then each log's last 20 lines in a fenced block; re-export.
   - Any `failed` → print its last 20 lines; AskUserQuestion "<lint|test> fails after scaffolding." — options
     `Commit anyway (failure recorded in the plan)` / `Stop (files stay uncommitted)`; `Stop` → Stopped.
7. **Commit.** `git -C "<repoPath>" add -- <each create/update path>` (deletes are already staged), then
   `git -C "<repoPath>" commit -m "chore: enforce standards"`. Fails (hook, nothing staged) → print the output;
   Stopped. `<sha>` = `git -C "<repoPath>" rev-parse HEAD` (40 hex).
   `mcp__trilium__set_attribute(<planNoteId>, appliedSha=<sha>)`; `mcp__trilium__edit_note_content(<planNoteId>)`:
   `**Status:** pending` → `**Status:** approved`, `applied sha: pending` → `applied sha: <sha>`, Decision `pending`
   → `Approved <ISO ts>; applied in <sha>`; re-export;
   `mcp__trilium__append_to_note(<Factory Log>, "- <ISO ts> [enforce-standards] applied <sha>")`.

## Completion

1. `mcp__trilium__set_attribute(<projectNoteId>, stageEnforce=done)` after `Approve`; `stageEnforce=skipped`
   after `Skip stage`.
2. `mcp__trilium__append_to_note(<Factory Log>, "- <ISO ts> [enforce-standards] stage done — <outcome>")`, outcome
   `applied <short sha>, <n> files, lint <result>, test <result>`, `nothing to apply` or `skipped by the user`.
3. `factory-event stage --stage enforce-standards --status done </dev/null`.
4. Print one paragraph: the plan note id, the commit sha and files (or skipped), any lint or test failure to fix;
   next stage: brainstorm.

Exports: project documents live at `<repoPath>/.factory/docs/<kind>.md`; drafts and logs stay in
`<repoPath>/.factory/enforce/` (gitignored).

## Direct-command behaviour

`/factory:enforce-standards` or `/factory:run enforce-standards` when `#stageEnforce` is `done` or `skipped`:
AskUserQuestion "enforce-standards is already <done|skipped> (Enforcement Plan <planNoteId>). Run it again?" —
options `Re-run (overwrite the document, keep labels)` / `Stop`.
- `Stop` → no writes; `factory-event stage --stage enforce-standards --status done </dev/null`; stop.
- `Re-run` → steps 1–7 and Completion. The plan note is overwritten in place with `#approval=pending`; an earlier
  `#appliedSha` stays until a new commit replaces it. `#stageEnforce` keeps its value until Completion;
  `Skip stage` on a re-run leaves an earlier `done` unchanged.

Entered with no verb (`/factory:run`), the stage runs only while `#stageEnforce` is unset and continues with
brainstorm after Completion; entered as a direct command, stop after Completion.

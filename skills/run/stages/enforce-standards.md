# Stage: enforce-standards

Turns the approved `Standards` into repository scaffolding: compares what they call for with `<repoPath>`, writes
an `Enforcement Plan`, and only once the user approves it writes the files, runs lint and tests and makes the one
scaffolding commit on `main` that SOP 4 allows (`chore: enforce standards`). `<projectNoteId>` =
`factory.projectNoteId`; `<Factory Log>` = its child titled `Factory Log`
(`mcp__trilium__get_child_notes(<projectNoteId>)`); `<ISO ts>` = `date -u +%Y-%m-%dT%H:%M:%SZ`. Every write follows
`$PLUGIN_ROOT/skills/run/references/trilium-schema.md` (find or create, templates).

- **Safety.** Until the plan is approved, write only under `<repoPath>/.factory/`; afterwards also the plan's paths
  in `<repoPath>`. Delete only files the approved plan lists with action `delete`. Commit only the plan's paths,
  only on `main`; never push. User edits that would enter the commit are shown at the gate first.
- **Free-text question**: AskUserQuestion with the options named; the user types the answer via Other.
- **Write `Enforcement Plan`** (template `$PLUGIN_ROOT/skills/run/templates/enforcement-plan.md`): Read it, fill every
  `{{placeholder}}` (`n/a` when not applicable), keep lines 1–2. `mcp__trilium__get_child_notes(<projectNoteId>)`,
  exact title `Enforcement Plan`: found → `mcp__trilium__set_note_content(<planNoteId>, …)`; absent →
  `mcp__trilium__create_note` (parent `<projectNoteId>`, title `Enforcement Plan`, type `text`, the content). Then
  `mcp__trilium__set_attribute` for `#factoryDoc=enforcement-plan`, `#project=<repoName>`, `#approval=pending`.
- **Export** `<kind>` from `<noteId>`: `mcp__trilium__get_note_content(<noteId>)` → Write
  `<repoPath>/.factory/docs/<kind>.md`, then refresh workstream copies (safe when there are none):
  `find "<repoPath>/.factory/workstreams" -mindepth 2 -maxdepth 2 -type d -name docs -exec cp "<repoPath>/.factory/docs/<kind>.md" {} \; 2>/dev/null; true`.
  Re-export kind `enforcement-plan` after every write or edit of the plan.
- **Stopped** (a `Stop` answer or a failed check below):
  `mcp__trilium__append_to_note(<Factory Log>, "- <ISO ts> [enforce-standards] stage stopped — <reason>")`;
  `factory-event stage --stage enforce-standards --status stopped </dev/null`; leave `#stageEnforce` and the
  Standards labels unchanged; tell the user which plan files are in the working tree uncommitted (a re-run commits
  them); end the run.

## Prerequisites

1. `mcp__trilium__get_attributes(<projectNoteId>)` shows `#stageStandards=done`. Else refuse
   `Missing #stageStandards=done on project <repoName>: run /factory:set-standards first.` and stop.
2. `Standards` (exact title under `<projectNoteId>`): `mcp__trilium__get_attributes(<standardsNoteId>)` shows
   `#approval=approved`. Else refuse `Missing #approval=approved on note Standards: run /factory:set-standards first.`
   and stop. Keep `#lintCmd`, `#testCmd`, `#buildCmd`, `#ciPlatform` (absent = empty). Missing
   `<repoPath>/.factory/docs/standards.md` → export kind `standards` from `<standardsNoteId>`. Its `lint:`,
   `test:`, `build:` lines are the tool commands.
3. `git -C "<repoPath>" branch --show-current` is `main` (`master` when the repo has no `main`). Else refuse
   `enforce-standards commits on main: switch <repoPath> to main, then re-run /factory:enforce-standards.` and stop.
4. `#stageEnforce` is `done` or `skipped` on the project → Direct-command behaviour below before step 1.

## Procedure

1. **Inventory.** Read `<repoPath>/.factory/docs/standards.md`. One row per item; Desired comes only from the
   Standards, Present from checks run in `<repoPath>`:
   - `.gitignore`: `.factory/`, `graphify-out/`, `.env`, and the dependency and build directories of the Standards'
     stack (e.g. `node_modules/`, `dist/`, `.venv/`); present = `grep -qxF '<entry>' .gitignore` per entry.
   - `Makefile`, when the Standards' CI/CD pipelines section wants a local Makefile: targets `lint`, `test`,
     `build`; present = `grep -qE '^<target>:' Makefile`.
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
   - Trait sections (Licence … Runtime operations): rows, present checks and shared-file extensions per the
     Scaffolding line of the chosen option in `$PLUGIN_ROOT/skills/run/references/standards-traits.md` (its
     Conventions decide what extends an existing row, what is a Risk, and what is no row at all).

   Action (the template's column): `create` (missing), `update` (incomplete: add only what is missing, keep the
   rest), `keep` (complete, or not chosen). Replacing a file (e.g. an old CI config) needs its own `delete` row.
   **Dirty paths** (`git -C "<repoPath>" status --porcelain --untracked-files=all`, so new files inside new
   directories are listed one by one): a path outside these rows → Stopped
   (`main has unrelated changes: <paths>; commit or stash them first`). A row path that is dirty gets `update` (the
   commit includes it). Unless it is `.gitignore` (setup leaves it uncommitted) or listed in
   `<repoPath>/.factory/enforce/applied.txt` (applied by an earlier run that stopped), mark its Present cell
   `(includes uncommitted changes)` and keep its diff for the gate: tracked →
   `git -C "<repoPath>" diff HEAD -- "<path>"`; untracked or no commits yet →
   `git -C "<repoPath>" diff --no-index -- /dev/null "<path>"`.
2. **Draft.** First pass of this run: `rm -rf "<repoPath>/.factory/enforce/files" && mkdir -p "<repoPath>/.factory/enforce/files"`.
   For every `create` and `update` row Write the complete resulting file to
   `<repoPath>/.factory/enforce/files/<path>` (an update = the current file plus the additions). Content comes only
   from the Standards:
   - `Makefile`: `.PHONY: lint test build` (+ `setup` when the traits ask); each target runs the tool command of the Standards' `lint:`, `test:` or
     `build:` line, never `make <target>`. A target with no tool command fails loudly:
     `@echo "<target>: not configured (see Standards)" >&2; exit 1`, and the plan lists it under Risks.
   - CI: on push and pull request to `main`, set up the Standards' runtimes, then run the configured lint, test and
     build commands (none for an empty one).
   - Dependabot or Renovate: the stack's package ecosystem plus the CI platform's actions, weekly.
   - `Containerfile`: multi-stage, the Standards' base image and version, non-root user.
   - Helm: minimal chart (`apiVersion: v2`, deployment, service, values for image and port).
   - Docs site: minimal config plus `docs/index.md` with the project name and the Goal's first line.
   - `README.md`: only the missing sections, using the Standards' commands.
   - Trait files: the content rule of the reference's Scaffolding line (e.g. `LICENSE` = the SPDX standard text,
     current year, holder from the Standards, else `git config user.name`).
3. **Write `Enforcement Plan`**, export it. Fill: `repo_name`; `standards_approved_at` from the `**Approved:**`
   line of `standards.md`; `approval` = `pending`; `summary` = counts per action; `gap_rows` = one row per inventory
   item `| <item> | <yes, no or partial: detail> | <desired> | <action> |`; `file_list` = one bullet per `create`,
   `update` or `delete` path with what it contains or what changes, then `Drafts: <repoPath>/.factory/enforce/files/`;
   `lint_cmd`, `test_cmd`, `build_cmd` (`none` when empty); `applied_sha` = `pending`; `risks` (updated existing
   files, uncommitted user changes that will be committed, placeholder targets, licence not chosen, …);
   `decision` = `pending`.
4. **Gate** (SOP 6). Print the gap table, the file list, for each `update`
   `git diff --no-index -- "<repoPath>/<path>" "<repoPath>/.factory/enforce/files/<path>"`, and for each row marked
   `(includes uncommitted changes)` its step 1 diff, saying these edits will be part of the commit. No `create`,
   `update` or `delete` row → say "nothing to enforce". AskUserQuestion "Apply this Enforcement Plan to <repoPath>
   and commit it on main?" — options `Approve` / `Edit (tell me what to change)` / `Skip stage`.
   - `Edit` → the change is the Other text (option picked without text → free-text question "What should change?",
     options `Nothing, ask again` / `Stop`). The text overrides the rows it names: a changed row gets the new Desired
     and only its draft is rewritten (no `rm -rf`); a dropped row becomes `keep` with Desired `dropped by the user`
     and its draft is deleted. A change to the Standards themselves (another tool, platform, artifact or version) →
     say it belongs in `/factory:set-standards` and leave those rows as they are. Rewrite the plan note
     (`mcp__trilium__set_note_content`; `#approval` stays `pending`), re-export, ask again.
   - `Skip stage` → `mcp__trilium__set_attribute(<planNoteId>, approval=rejected)`;
     `mcp__trilium__append_to_note(<Factory Log>, "- <ISO ts> [enforce-standards] plan rejected — stage skipped")`;
     `mcp__trilium__edit_note_content(<planNoteId>)`: `**Status:** pending` → `**Status:** rejected`, Decision
     `pending` → `Skipped by the user <ISO ts>`; re-export; go to Completion (skipped). The repo and the Standards
     labels are untouched.
   - `Approve` → `mcp__trilium__set_attribute(<planNoteId>, approval=approved)`;
     `mcp__trilium__append_to_note(<Factory Log>, "- <ISO ts> [enforce-standards] plan approved")`. Nothing to
     enforce → `mcp__trilium__edit_note_content`: Status `approved`, Decision `Approved <ISO ts>; nothing to apply`;
     re-export; no `#appliedSha`; step 8. Else steps 5–8.
5. **Apply.** Repeat step 1's unrelated-changes check (`git -C "<repoPath>" status --porcelain --untracked-files=all`;
   fails → Stopped). Each `create`/`update` path:
   `mkdir -p "$(dirname "<repoPath>/<path>")" && cp "<repoPath>/.factory/enforce/files/<path>" "<repoPath>/<path>"`;
   each `delete` row: `git -C "<repoPath>" rm -q -- "<path>"`. Nothing else. Write the applied paths, one per line,
   to `<repoPath>/.factory/enforce/applied.txt`.
6. **Verify** what the labels will hold after step 8: per target `lint`, `test`, `make <target>` when step 8 will
   point that label at the Makefile, else `#lintCmd` / `#testCmd` (empty → `none`, skip). Run with Bash timeout
   600000: `cd "<repoPath>" && ( <cmd> ) > "<repoPath>/.factory/enforce/<lint|test>.log" 2>&1; echo "exit=$?"`.
   - Result: exit 0 → `ok`; non-zero and
     `grep -qiE 'no tests? (found|ran|to run)|no test files|collected 0 items|no (input )?files (were )?(found|matched)' <log>`
     → `no tests yet` (tolerated); otherwise `failed`.
   - `mcp__trilium__append_to_note(<planNoteId>, …)` a `## Result` section: `Applied <ISO ts>`, one line per command
     `- Lint <cmd>: exit <n> — <result>` (same for Test), then each log's last 20 lines in a fenced block; re-export.
   - Any `failed` → print its last 20 lines; AskUserQuestion "<lint|test> fails after scaffolding." — options
     `Commit anyway (failure recorded in the plan)` / `Stop (files stay uncommitted)`; `Stop` → Stopped.
7. **Commit.** `git -C "<repoPath>" add -- <each create/update path>` (deletes are already staged), then
   `git -C "<repoPath>" commit -m "chore: enforce standards"`. Fails (hook, nothing staged) → print the output;
   Stopped. `<sha>` = `git -C "<repoPath>" rev-parse HEAD` (40 hex); `rm -f "<repoPath>/.factory/enforce/applied.txt"`.
   `mcp__trilium__set_attribute(<planNoteId>, appliedSha=<sha>)`; `mcp__trilium__edit_note_content(<planNoteId>)`:
   `**Status:** pending` → `**Status:** approved`, `applied sha: pending` → `applied sha: <sha>`, Decision `pending`
   → `Approved <ISO ts>; applied in <sha>`; re-export;
   `mcp__trilium__append_to_note(<Factory Log>, "- <ISO ts> [enforce-standards] applied <sha>")`.
8. **Point the labels at the Makefile** (after `Approve` only). Applies when the Standards want a local Makefile,
   its row was not dropped, and it is committed (`git -C "<repoPath>" status --porcelain -- Makefile` empty). For
   each target `lint`, `test`, `build` whose Standards tool command is non-empty and
   `grep -qE '^<target>:' "<repoPath>/Makefile"` succeeds:
   `mcp__trilium__set_attribute(<standardsNoteId>, <lintCmd|testCmd|buildCmd>=make <target>)` and
   `mcp__trilium__edit_note_content(<standardsNoteId>)` setting that label's row of the Machine commands table to
   `make <target>`. Any label changed → export kind `standards` from `<standardsNoteId>`;
   `mcp__trilium__append_to_note(<planNoteId>, "- Labels: <label> → make <target> (tool: <tool command>)")`, one line
   per label, under `## Result`; re-export. Otherwise (no Makefile wanted, row dropped, `Skip stage`) the labels
   stay the tool commands.

## Completion

1. `mcp__trilium__set_attribute(<projectNoteId>, stageEnforce=done)` after `Approve`; `stageEnforce=skipped`
   after `Skip stage`.
2. `mcp__trilium__append_to_note(<Factory Log>, "- <ISO ts> [enforce-standards] stage done — <outcome>")`, outcome
   `applied <short sha>, <n> files, lint <result>, test <result>`, `nothing to apply` or `skipped by the user`.
3. `factory-event stage --stage enforce-standards --status done </dev/null`.
4. Print one paragraph: the plan note id, the commit sha and files (or skipped), the commands the labels now hold,
   any lint or test failure to fix; next stage: brainstorm.

Exports: project documents live at `<repoPath>/.factory/docs/<kind>.md`; drafts, logs and `applied.txt` stay in
`<repoPath>/.factory/enforce/` (gitignored).

## Direct-command behaviour

`/factory:enforce-standards` or `/factory:run enforce-standards` when `#stageEnforce` is `done` or `skipped`:
AskUserQuestion "enforce-standards is already <done|skipped> (Enforcement Plan <planNoteId>). Run it again?" —
options `Re-run (overwrite the document, keep labels)` / `Stop`.
- `Stop` → no writes; `factory-event stage --stage enforce-standards --status stopped </dev/null`; stop.
- `Re-run` → steps 1–8 and Completion. The plan note is overwritten in place with `#approval=pending`; an earlier
  `#appliedSha` stays until a new commit replaces it. `#stageEnforce` keeps its value until Completion;
  `Skip stage` on a re-run leaves an earlier `done` unchanged.

Entered with no verb (`/factory:run`), the stage runs only while `#stageEnforce` is unset and continues with
brainstorm after Completion; entered as a direct command, stop after Completion.

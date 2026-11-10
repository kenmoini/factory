# Stage: brainstorm

Opens a workstream: slug, branch and worktree, the `Workstreams/<slug>` note with its `Overview`, then the
`superpowers:brainstorming` conversation (→ `Spec`) and `superpowers:writing-plans` (→ `Plan`), both stored in Trilium
by you, never as `docs/superpowers/` files. `<projectNoteId>` = `factory.projectNoteId`; `<Factory Log>` = its child
titled `Factory Log` (`mcp__trilium__get_child_notes(<projectNoteId>)`); `<ws>` = the workstream note id; `<wsd>` =
`<repoPath>/.factory/workstreams/<slug>`; `<docs>` = `<wsd>/docs`; `<ISO ts>` = `date -u +%Y-%m-%dT%H:%M:%SZ`.
Every write follows `$PLUGIN_ROOT/skills/run/references/trilium-schema.md` (find or create, labels, templates).

- **Free-text question**: AskUserQuestion with the options named; the user types the answer via Other. Keep answers
  verbatim; never invent one.
- **Write `<Title>` under `<parent>`**: `mcp__trilium__get_child_notes(<parent>)`, exact title: found →
  `mcp__trilium__set_note_content(<noteId>, …)`; absent → `mcp__trilium__create_note` (parent, title, type `text`,
  Markdown content). Then one `mcp__trilium__set_attribute` per label named (markers empty).
- **Export `<kind>`**: `mkdir -p "<docs>"`; `mcp__trilium__get_note_content(<noteId>)` → Write `<docs>/<kind>.md`.
- **Log**: `mcp__trilium__append_to_note(<Factory Log>, "- <ISO ts> [brainstorm] <event>")`.
- **Stop brainstorm** (a `Stop` answer or a stop below): the Stray check (Completion step 1, keeping the baseline);
  Log `stage stopped — <reason>`; `factory-event stage --stage brainstorm --status stopped --workstream <slug>
  </dev/null` (no `--workstream` before a slug is fixed); leave `#stageBrainstorm` unset; end the run. Notes and
  worktree already made stay; a later run with the same slug resumes them.

## Prerequisites

1. `mcp__trilium__get_attributes(<projectNoteId>)` shows `#stageEnforce` = `done` or `skipped`. Else refuse
   `Missing #stageEnforce=done on project <repoName>: run /factory:enforce-standards first.` and stop.
2. Preflight `tools.superpowers=true`. Else refuse `The superpowers plugin is missing: run /plugin install
   superpowers@claude-plugins-official, then /factory:brainstorm.` and stop.
3. `git -C "<repoPath>" rev-parse -q --verify HEAD` succeeds (`factory-worktree ensure` branches from a commit). Else
   refuse `<main> has no commits: run /factory:setup.` (`<main>` written out, schema Placeholders) and stop.

## Procedure

1. **Slug.** Candidate: the target argument when the verb is `brainstorm`, else the `--workstream` value (SKILL.md
   Arguments), else Free-text question "Workstream slug? Lowercase letters, digits and `-`, at most 63 characters
   (e.g. `auth-login`)." options `Suggest slugs from my overview` / `Stop`. Suggest → do step 2 now (it is then
   done), then AskUserQuestion with up to 3 valid slugs drawn from the overview (own slug via Other).
   - Valid = matches `^[a-z0-9][a-z0-9-]{0,62}$` and does not end in `-`. Invalid → tell the user which rule it breaks
     (longer than 63, a character outside `a-z 0-9 -`, starts or ends with `-`) and ask again; a third invalid answer
     → Stop brainstorm (`invalid slug`).
   - Existing workstream: `mcp__trilium__search_notes("#factoryWorkstream #slug='<slug>' #project='<repoName>'")`. A hit
     is `<ws>`; `mcp__trilium__get_attributes(<ws>)`:
     - `#stageBrainstorm` unset → **Resume**: a step whose note already exists (`Overview`, `Spec`, `Plan`) is
       skipped with its question, never rewritten; tell the user which steps are already done.
     - `#stageBrainstorm=done`, `#wsStatus` ∈ {`design`, `planned`, `validated`} → AskUserQuestion
       `Redo the design of <slug> / Choose another slug / Stop`. **Redo** → first `mcp__trilium__delete_attribute` on
       `<ws>` for each of `stageUiux`, `stageApi`, `stagePlan`, `stageValidate` that is set (nothing downstream may run
       on a half-redone design; milestones and tasks stay for the plan stage to realign); finish step 1; in step 3
       only Cache and activate; then steps 4–7 (the Overview stays).
     - `#stageBrainstorm=done`, any other `#wsStatus` → say "`<slug>` is <wsStatus>; change its tasks with
       /factory:plan"; AskUserQuestion `Choose another slug / Stop`.
   - Worktree: `factory-worktree ensure <slug> --repo "<repoPath>"` → `{path, branch, created, branchCreated}`.
     - Exit 2 (branch `<slug>` exists, not made by the factory) → AskUserQuestion
       `Adopt existing branch <slug> / Choose another slug / Stop`; Adopt → rerun with `--adopt`.
     - Exit 3 → show its `error`; back to the slug question. Exit 1 → show `error`; Stop brainstorm.
2. **Overview.** Free-text question "In a few sentences, what is this workstream?" options
   `Let the brainstorm ask me` / `Stop`. `Let the brainstorm ask me` → overview text `n/a — settled in brainstorming`.
3. **Trilium notes.** Write in this order:

   | Title | Parent | Content | Labels |
   |---|---|---|---|
   | `Workstreams` | `<projectNoteId>` | `# Workstreams` | `#project=<repoName>` |
   | `<slug>` | `Workstreams` | `# <slug>` + "Workstream of <repoName>; branch `<branch>`, worktree `<path>`." | `#factoryWorkstream`, `#slug=<slug>`, `#branch=<branch>`, `#worktree=<path>`, `#wsStatus=brainstorm`, `#project=<repoName>` |
   | `Overview` | `<ws>` | template `overview` | `#factoryDoc=overview`, `#approval=approved`, `#project=<repoName>`, `#workstream=<slug>` |

   - Overview body: Read `$PLUGIN_ROOT/skills/run/templates/overview.md`; fill `{{slug}}`, `{{branch}}`,
     `{{worktree}}` (step 1 `branch`, `path`), `{{created_at}}` (`<ISO ts>`), `{{overview}}` (the answer verbatim),
     `{{problem}}`, `{{scope}}`, `{{out_of_scope}}` (only what the answer states, else
     `n/a — settled in brainstorming`), `{{goal_ref}}` = `<docs>/goal.md`, `{{standards_ref}}` = `<docs>/standards.md`;
     keep lines 1–2. `#approval=approved`: the text is the user's own.
   - Resume: an existing `<slug>` note keeps its `#wsStatus`; `#branch` and `#worktree` are re-set from step 1.
   - Cache and activate: `factory-config set workstreams.<slug>.noteId <ws> --repo "<repoPath>"`;
     `factory-config set activeWorkstream <slug> --repo "<repoPath>"`;
     `mcp__trilium__set_attribute(<projectNoteId>, activeWorkstream=<slug>)`.
4. **Context exports.** Project documents are already exported by their stages to `<repoPath>/.factory/docs/`; copy
   them (never re-read Trilium for them): `mkdir -p "<docs>"`, then
   `for k in goal standards examination; do f="<repoPath>/.factory/docs/$k.md"; [ -f "$f" ] && cp "$f" "<docs>/"; done`
   (`examination.md` exists only for brownfield). `goal.md` or `standards.md` missing in `<docs>/` → tell the user to
   re-run `/factory:examine` or `/factory:set-standards` (they write the export); Stop brainstorm. Export `overview`
   from the `Overview` note.
   - **Stray baseline**, only when step 5 or 7 will invoke a skill in this session. If `<wsd>/stray-baseline` is
     absent (an interrupted earlier session keeps its own), record what already exists:
     `git -C "<repoPath>" status --porcelain -z --untracked-files=all -- .superpowers docs/superpowers > "<wsd>/stray-baseline"; git -C "<repoPath>" rev-parse -q --verify HEAD > "<wsd>/stray-head"`.
5. **Design (`superpowers:brainstorming`).** Resume (not Redo) with a `Spec` note → step 7. Invoke the Skill tool,
   skill `superpowers:brainstorming`, args exactly this (`<docs>`, `<repoPath>` written out as absolute paths;
   `<overview text>`: step 2's answer, else the "In the user's words" section of `<docs>/overview.md`):

   ```
   Preference: do NOT write docs/superpowers/specs or docs/superpowers/plans files. When the design is approved, give me the full design document back in a single message; I store it in Trilium. Draft location for the builder check: <docs>/spec-draft.md; never write under <repoPath>/docs/. Do not offer the visual companion or spikes in this session; the factory's UI/UX stage produces mockups later. Context documents to read first: <docs>/goal.md, <docs>/standards.md (and <docs>/examination.md if present), and the workstream overview below. Overview: <overview text>
   ```

   Follow the skill's conversation in this context, with these rules:
   - Each question it puts to the user is an AskUserQuestion: the question as the skill words it, options
     `I'm done answering: write the design` / `Stop`; the user answers via Other. `I'm done answering` still ends
     in a written design (the factory needs a Spec, whatever size the skill gives the work).
   - It writes nothing outside `<repoPath>/.factory/` (no `docs/`, no `.superpowers/`, no spike code) and commits
     nothing; anything that appears anyway is moved aside by the Stray check.
   - Its builder-check subagent reads `<docs>/spec-draft.md` and is allowed (description ending `[task:none]`; no
     Agent Run note: not a factory agent).
   - Its HARD-GATE approval is yours to ask when the full design document comes back:
     AskUserQuestion `Approve design / Request changes / Stop`. Request changes → the user's changes (via Other) go
     back into the conversation; ask again on the revised document. Approve → step 6 before anything else.
   - The skill's next step, `superpowers:writing-plans`, is step 7. Invoke no other skill (no execution, worktree or
     review skill): the factory's own stages build the plan.
6. **Spec.** Write `Spec` under `<ws>`: content = the approved design document, verbatim Markdown (no template);
   labels `#factoryDoc=spec`, `#approval=approved`, `#project=<repoName>`, `#workstream=<slug>`. Export `spec`;
   `rm -f "<docs>/spec-draft.md"` (agents read every file in `<docs>/`). Log `<slug> spec approved`.
7. **Plan (`superpowers:writing-plans`).** Resume (not Redo) with a `Plan` note → Completion. Invoke the Skill tool,
   skill `superpowers:writing-plans`, args exactly this (`<docs>`, `<repoPath>` written out as absolute paths):

   ```
   Preference: do NOT write docs/superpowers/specs or docs/superpowers/plans files; never write under <repoPath>/docs/. When the plan is approved, give me the full plan back in a single message; I store it in Trilium. Execution method already chosen: the factory's execute stage runs this plan, so do not invoke an execution skill. Context documents to read first: <docs>/goal.md, <docs>/standards.md (and <docs>/examination.md if present). Spec: <docs>/spec.md
   ```

   - Same rules as step 5 (questions via AskUserQuestion, no `docs/superpowers/` file, no other skill). Its plan
     review is yours: on the full plan, AskUserQuestion `Approve plan / Request changes / Stop`; Request changes →
     revise and ask again.
   - Approve → `<rev>` = `1` (Redo: the `#planRev` of `<ws>` + 1). Write `Plan` under `<ws>`: content = the plan
     verbatim; labels `#factoryDoc=plan`, `#approval=approved`, `#planRev=<rev>`, `#project=<repoName>`,
     `#workstream=<slug>`. Then `mcp__trilium__set_attribute(<ws>, planRev=<rev>)`. Export `plan`.
     Log `<slug> plan rev <rev> approved`.

## Completion

1. **Stray check** (also before Stop brainstorm). No `<wsd>/stray-baseline` → skip (no skill ran). Else move only
   what the skills added since the baseline to `<wsd>/stray/` (paths kept; `-z` handles spaces and non-ASCII names):

   ```
   cd "<repoPath>" && b="<wsd>/stray-baseline" && git status --porcelain -z --untracked-files=all -- .superpowers docs/superpowers | while IFS= read -r -d '' e; do grep -qzxF -- "$e" "$b" && continue; case "$e" in '?? '*) f="${e#?? }"; mkdir -p "<wsd>/stray/$(dirname "$f")" && mv -- "$f" "<wsd>/stray/$f" && echo "moved: $f";; *) echo "changed (tracked): ${e#???}";; esac; done
   ```

   Warn the user with every `moved:` / `changed (tracked):` line (tracked changes stay for them to revert; `main`
   must be clean before execute). `git -C "<repoPath>" rev-parse -q --verify HEAD` differs from `<wsd>/stray-head` →
   warn "the brainstorming skill committed on <current branch>; inspect `git log -1`" (revert nothing). At
   Completion (not on Stop) then `rm -f "<wsd>/stray-baseline" "<wsd>/stray-head"`.
2. `mcp__trilium__set_attribute(<ws>, stageBrainstorm=done)`; `mcp__trilium__set_attribute(<ws>, wsStatus=design)`.
3. Log `stage done — <slug>: Spec and Plan rev <rev> approved, worktree <path>` (Redo: add `, redo`).
4. `factory-event stage --stage brainstorm --status done --workstream <slug> </dev/null`.
5. `factory-preflight` again, so later stages of this run see `<slug>` as `factory.activeWorkstream`. `<slug>` also
   replaces any `--workstream` value for the rest of this run: carry it forward to every later stage.
6. Print one paragraph: slug, branch and worktree path, `<ws>`, the export paths in `<docs>/`; next stage: uiux.

## Direct-command behaviour

`/factory:brainstorm [<slug>]` or `/factory:run brainstorm [<slug>]`: a positional slug wins over `--workstream`
(SKILL.md warns); none → step 1 asks. It makes `<slug>` the active workstream, even when others exist. An existing
slug resumes or, after an explicit `Redo`, redoes the design (step 1); never a second `<slug>` note under
`Workstreams`. After Completion, stop.

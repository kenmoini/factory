# Trilium schema

Single source of truth for every Trilium note, title, label and search the factory uses. Stage files,
`sop.md`, `agent-protocol.md`, `execute-loop.md` and agent files may only use labels declared in the
**Labels** table below. Read this file before any Trilium write.

## Rules

- **Only the orchestrator touches Trilium.** Agents never get `mcp__trilium__*` tools; they read file exports.
- **Every note is a `text` note whose content is Markdown.** Create with `mcp__trilium__create_note`
  (parent note id, title, type `text`, content); replace with `mcp__trilium__set_note_content`; add to
  the end with `mcp__trilium__append_to_note`; small in-place edits with `mcp__trilium__edit_note_content`.
  Argument names follow each tool's own schema; the roles named here are what matters.
- **Machine state lives only in labels**, never in note bodies. Decide by labels; bodies are for humans and agents.
- **Labels**: one `mcp__trilium__set_attribute` per label (type `label`, name, value). It replaces a
  same-name label, so re-setting is idempotent; never add a second label of the same name. Marker labels
  (`#factoryRoot`, `#factoryProject`, `#factoryWorkstream`, `#factoryMilestone`, `#factoryTask`,
  `#factoryReview`, `#factoryValidation`, `#factoryAgentRun`) have an empty value. Remove a label with
  `mcp__trilium__delete_attribute`. Relations are not used.
- **Denormalised labels**: every note below a project carries `#project=<repo>`; every note below a
  workstream also carries `#workstream=<slug>`; every note below a task (and the task) carries
  `#taskId=<T-NNN>`. Searches never depend on ancestors.
- **Find or create**: before creating a child, `mcp__trilium__get_child_notes(<parent>)` and match the exact
  title; reuse the note if present (overwrite content, re-set labels). Containers (`Agent Runs`,
  `Workstreams`, `Milestones`, `Validation`) are plain text notes found the same way; they carry only
  `#project` (and `#workstream` for `Milestones`, `Validation`).
- **Templates**: document bodies come from `$PLUGIN_ROOT/skills/run/templates/<name>.md`: Read, fill every
  `{{placeholder}}` (write `n/a` when not applicable), keep lines 1–2, create the note.
- **Exports for agents**: the orchestrator copies note content to files that agents read:
  `.factory/workstreams/<slug>/docs/<kind>.md` (`goal`, `examination`, `standards`, `overview`, `spec`,
  `plan`, `uiux`, `api-design`) via `mcp__trilium__get_note_content` + Write. Re-export after every change.
- **Ids cached** in `.factory/config.json`: `projectNoteId`, `workstreams.<slug>.noteId` (via `factory-config
  set <key> <value> --repo <repo>`). Everything else is found by title under a cached id or by search.
- **Timestamps** are UTC ISO-8601 `YYYY-MM-DDTHH:MM:SSZ` (`date -u +%Y-%m-%dT%H:%M:%SZ`); shas are full 40-hex;
  numbers are plain decimal strings.
- **Stage state is always `mcp__trilium__get_attributes(<noteId>)`**, never a search.

## Hierarchy

`<repo>` is the basename of the repo root (also `#repo` and `#project`). Titles are exact.

```
root
└─ ClaudeProjects                      #factoryRoot
   └─ <repo>                           #factoryProject #repo #repoPath=<abs> #projectKind=greenfield|brownfield
      │                                #stageSetup #stageExamine #stageStandards #stageEnforce #stageGraph
      │                                #activeWorkstream #dashboardPort
      ├─ Factory Log                   #factoryDoc=log  (append_to_note, one line per event)
      ├─ Goal                          #factoryDoc=goal #approval=approved
      ├─ Codebase Examination          #factoryDoc=examination  (brownfield only)
      ├─ Standards                     #factoryDoc=standards #lintCmd #testCmd #buildCmd #ciPlatform #approval
      ├─ Enforcement Plan              #factoryDoc=enforcement-plan #approval=pending|approved|rejected #appliedSha
      ├─ Agent Runs                    container for runs without a task
      │  └─ <ISO ts> <agentType> <agentId>   #factoryAgentRun …
      └─ Workstreams                   container
         └─ <slug>                     #factoryWorkstream #slug #branch #worktree #wsStatus
            │                          #stageBrainstorm #stageUiux #stageApi #stagePlan #stageValidate
            │                          #planRev #validatedPlanRev #stageExecute
            ├─ Overview                #factoryDoc=overview #approval=approved
            ├─ Spec                    #factoryDoc=spec #approval=approved
            ├─ Plan                    #factoryDoc=plan #approval=approved #planRev
            ├─ UI-UX Spec              #factoryDoc=uiux
            ├─ API Design              #factoryDoc=api-design #apiDocPath
            ├─ Validation              container
            │  └─ Round <N>            #factoryValidation #round #verdict=pass|fail #planRev
            │     └─ <lens>            #lens #round #verdict=PASS|FAIL  (one child per plan-adversary)
            └─ Milestones              container
               └─ M<n> <title>         #factoryMilestone #milestoneId #order #status=todo|active|done
                  └─ T-NNN <title>     #factoryTask #taskId #order #milestoneId #dependsOn #status #round
                     │                 #base #head #mergedSha #builderAgentId #agentId #escalation
                     ├─ Task Spec      #factoryDoc=task-spec
                     ├─ Build Report   #factoryDoc=build-report  (one section appended per round)
                     ├─ Review R<n> <reviewer>   #factoryReview #round #reviewer #verdict=PASS|CHANGES
                     ├─ Approval R<n>  #factoryDoc=approval #round #verdict=APPROVE|ESCALATE
                     ├─ Human Decision #factoryDoc=human-decision #verdict=approve|reject
                     └─ <ISO ts> <agentType> <agentId>   #factoryAgentRun (builder/reviewer/approver/spec-writer runs)
```

The task note's own body is the plan-level task description (template `task-spec`, sections `Goal`,
`Acceptance criteria`, `Files`, `Out of scope`); the child `Task Spec` holds the spec-writer's full spec.

## Labels

| Label | Lives on | Values |
|---|---|---|
| `#factoryRoot` | `ClaudeProjects` | marker |
| `#factoryProject` | project note | marker |
| `#repo` | project | repo basename |
| `#repoPath` | project | absolute repo root path |
| `#projectKind` | project | `greenfield` \| `brownfield` |
| `#stageSetup` | project | `done` |
| `#stageExamine` | project | `done` |
| `#stageStandards` | project | `done` |
| `#stageEnforce` | project | `done` \| `skipped` |
| `#stageGraph` | project | `done` (set by the graph stage after a successful build or update) |
| `#activeWorkstream` | project | slug (mirrors `.factory/config.json`) |
| `#dashboardPort` | project | port number (default `7777`) |
| `#factoryDoc` | every document note | `log` \| `goal` \| `examination` \| `standards` \| `enforcement-plan` \| `overview` \| `spec` \| `plan` \| `uiux` \| `api-design` \| `task-spec` \| `build-report` \| `approval` \| `human-decision` |
| `#approval` | Goal, Standards, Enforcement Plan, Overview, Spec, Plan | `pending` \| `approved` \| `rejected` |
| `#lintCmd` | Standards | shell command run from the repo/worktree root; empty = none |
| `#testCmd` | Standards | shell command; empty = none |
| `#buildCmd` | Standards | shell command; empty = none |
| `#ciPlatform` | Standards | e.g. `github-actions` \| `gitlab-ci` \| `none` |
| `#appliedSha` | Enforcement Plan | sha of the `chore: enforce standards` commit on `main` |
| `#factoryAgentRun` | agent run note | marker |
| `#agentType` | agent run | agent name: `spec-writer` \| `builder` \| `security-reviewer` \| `ux-reviewer` \| `ui-design-reviewer` \| `code-reviewer` \| `approver` \| `codebase-examiner` \| `standards-researcher` \| `plan-adversary` |
| `#agentId` | agent run; task | agent id from the Agent tool result; on a task: id of the most recent agent run for it |
| `#status` | agent run | `running` \| `done` \| `failed` |
| `#status` | milestone | `todo` \| `active` \| `done` |
| `#status` | task | `todo` \| `spec` \| `building` \| `reviewing` \| `fixing` \| `approving` \| `merging` \| `done` \| `needs-human` \| `blocked` |
| `#startedAt` | agent run | ISO ts at dispatch |
| `#endedAt` | agent run | ISO ts when the result was parsed |
| `#taskId` | task and every note below it; agent run of a task | `T-NNN` (zero-padded, unique within the workstream) |
| `#factoryWorkstream` | workstream note | marker |
| `#slug` | workstream | slug, `^[a-z0-9][a-z0-9-]{0,62}$`, no trailing `-` |
| `#branch` | workstream | branch name (= slug) |
| `#worktree` | workstream | absolute path `<repo>/.factory/worktrees/<slug>` |
| `#wsStatus` | workstream | `brainstorm` \| `design` \| `planned` \| `validated` \| `executing` \| `paused` \| `done` |
| `#stageBrainstorm` | workstream | `done` |
| `#stageUiux` | workstream | `done` \| `skipped` |
| `#stageApi` | workstream | `done` \| `skipped` |
| `#stagePlan` | workstream | `done` |
| `#stageValidate` | workstream | `pass` \| `fail` |
| `#planRev` | workstream (authoritative); Plan (mirror); Validation round (rev validated) | integer, starts `1`, +1 per realign |
| `#validatedPlanRev` | workstream | `#planRev` value of the last passing validation |
| `#stageExecute` | workstream | `done` |
| `#apiDocPath` | API Design | repo-relative path of the API doc (e.g. `docs/openapi.yaml`) |
| `#factoryValidation` | Validation `Round <N>` | marker |
| `#lens` | lens child of a round | `feasibility` \| `missing-requirements` \| `security` \| `ux` \| `sequencing` \| `standards` |
| `#round` | task; Review; Approval; Validation round; lens child | integer; task starts `0`, review rounds start `1` |
| `#verdict` | Validation round | `pass` \| `fail` |
| `#verdict` | lens child | `PASS` \| `FAIL` |
| `#verdict` | Review | `PASS` \| `CHANGES` |
| `#verdict` | Approval | `APPROVE` \| `ESCALATE` |
| `#verdict` | Human Decision | `approve` \| `reject` (latest decision) |
| `#factoryMilestone` | milestone note | marker |
| `#milestoneId` | milestone; task | `M<n>` |
| `#order` | milestone; task | integer, execution order (sort numerically) |
| `#factoryTask` | task note | marker |
| `#dependsOn` | task | comma list of task ids (`T-001,T-003`) or empty |
| `#base` | task | sha of the branch HEAD when BUILD started (moves after a conflict rebase) |
| `#head` | task | sha of the worktree HEAD at the latest review |
| `#mergedSha` | task | sha of the `--no-ff` merge commit on `main` |
| `#builderAgentId` | task | agent id of the builder (target of `SendMessage` fix rounds) |
| `#escalation` | task | `fix-cap` \| `approver` \| `builder-blocked` \| `merge-conflict` \| `reviewer-failed`; deleted when the task leaves `needs-human`/`blocked` |
| `#factoryReview` | Review note | marker |
| `#reviewer` | Review | `security` \| `ux` \| `ui-design` \| `code` |
| `#project` | every note below a project | repo basename |
| `#workstream` | every note below a workstream | slug |

## Titles

| Note | Title | Parent |
|---|---|---|
| root container | `ClaudeProjects` | `root` |
| project | `<repo>` | `ClaudeProjects` |
| log / docs | `Factory Log`, `Goal`, `Codebase Examination`, `Standards`, `Enforcement Plan` | project |
| containers | `Agent Runs`, `Workstreams` | project |
| workstream | `<slug>` | `Workstreams` |
| workstream docs | `Overview`, `Spec`, `Plan`, `UI-UX Spec`, `API Design` | workstream |
| containers | `Validation`, `Milestones` | workstream |
| validation | `Round <N>`; children `<lens>` | `Validation`; round |
| milestone / task | `M<n> <title>` / `T-NNN <title>` | `Milestones` / milestone |
| task children | `Task Spec`, `Build Report`, `Review R<n> <reviewer>`, `Approval R<n>`, `Human Decision` | task |

## Agent Run note convention

One note per dispatch (a `SendMessage` resumption counts as a new run of the same agent id).

1. **Before the Agent call**: `create_note` under the task note (or project `Agent Runs` when no task) with
   title `<ISO ts> <agentType> pending`, content `Dispatched <ISO ts>. Brief: <path or first line>`, then labels
   `#factoryAgentRun`, `#agentType=<agentType>`, `#status=running`, `#startedAt=<ISO ts>`, `#project`,
   and when applicable `#workstream`, `#taskId`.
2. **After the result**: `rename_note` to `<ISO ts> <agentType> <agentId>` (same ts as created); set
   `#agentId=<agentId>`, `#status=done` (parsed contract) or `failed` (error / unparseable), `#endedAt=<ISO ts>`;
   `append_to_note` the agent's ≤ 15 summary lines and its fenced json block. On a task also set the task's
   `#agentId=<agentId>`.

Every Agent `description` contains `[task:<noteId>]` (task note id) or `[task:none]`; the dashboard joins live
agents to cards through it and through `#agentId`.

## Factory Log line

`append_to_note(<Factory Log>, "- <ISO ts> [<stage>] <event>")`, one line per event, e.g.
`- 2026-11-10T14:03:22Z [execute] T-001 merged 3f2a…` or `- … [set-standards] stage done`.

## Canonical searches

`mcp__trilium__search_notes` queries. Quote values that contain `-`, `/`, `.` or spaces. Except the first two,
every query also carries `#project='<repo>'`, placed before any `orderBy`/`limit` (slugs and task ids are only
unique per project / workstream). If `search_notes` ignores `orderBy`/`limit`, sort and cut client-side; always re-sort `#order`
numerically.

| Purpose | Query |
|---|---|
| root | `#factoryRoot` |
| project | `#factoryProject #repoPath='<abs>'` |
| workstream (cache miss) | `#factoryWorkstream #slug='<slug>'` |
| next task (candidates) | `#factoryTask #workstream='<slug>' #status=todo orderBy #order asc` — take the first whose `#dependsOn` are all done; `limit 1` only when no deps exist |
| done task ids | `#factoryTask #workstream='<slug>' #status=done` |
| in-flight task | `#factoryTask #workstream='<slug>' #status!=todo #status!=done limit 1` |
| blockers | `#factoryTask #workstream='<slug>' (#status='needs-human' OR #status=blocked)` |
| task by id | `#factoryTask #workstream='<slug>' #taskId='T-001'` |
| milestone tasks open | `#factoryTask #workstream='<slug>' #milestoneId='M1' #status!=done` |
| reviews of a round | `#factoryReview #workstream='<slug>' #taskId='T-001' #round=2` |
| latest validation | `#factoryValidation #workstream='<slug>' orderBy #round desc limit 1` |
| agent run by id | `#factoryAgentRun #agentId='<agentId>'` |
| document by kind | `#factoryDoc=<kind> #workstream='<slug>'` (workstream docs) or `#factoryDoc=<kind>` (project docs) |

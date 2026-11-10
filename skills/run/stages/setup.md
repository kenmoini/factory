# Stage: setup

Idempotent checklist that readies this machine and `<repoPath>` (= `git.root`, else the cwd; `<repoName>` = its
basename). Each step: **check** (the preflight field or command named) → if unmet, tell the user what will be
installed or changed and confirm with AskUserQuestion → **fix** → **re-check** (`factory-preflight` again; decide on
the fresh JSON). A satisfied step prints one line (`setup: <step> ok — <detail>`) and asks nothing. Never install,
register or change anything without that confirmation (one question may cover several items). Track every change
for the summary.

- **Secret.** The ETAPI token comes only from AskUserQuestion (Other) and is stored only with
  `factory-config set etapiToken '<token>'` (mode 600; prints the file path, not the value). Never echo, print or
  summarise it; never put it in Trilium, the Factory Log, `.factory/` or the repo. In commands write
  `"$(factory-config get etapiToken)"`; never run `factory-config get etapiToken` bare.
- **PATH.** Bash calls do not share environment: once uv or bun is installed in this run, start every later Bash
  call with `export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"; `.
- **Stop setup** (a `Stop setup` answer, or a re-check that still fails): print what is missing and the user's next
  action; `factory-event stage --stage setup --status stopped </dev/null`; if `Factory Log` exists and
  `mcp__trilium__*` tools are available, append `- <ISO ts> [setup] stage stopped — <reason>`; end the whole run.

## Prerequisites

None: stage 0, run whenever SKILL.md "Ensure setup" says so. Trilium may be unreachable or its tools absent, so
nothing is read from Trilium before step 9.

## Procedure

1. **Bun** (runs every `factory-*` command except `factory-event`).
   - Check: preflight is not a bare `{"error":…}` and `tools.bun=true`. On an error: `command -v bun`,
     `bun --version` (≥ 1.2.10). Bun fine but preflight still errors → run `factory-preflight`, show stderr, Stop setup.
   - Missing or older → tell the user Bun (the factory's runtime) will be installed via Homebrew, else bun.sh;
     AskUserQuestion `Install Bun / Stop setup` (or `Upgrade Bun / Stop setup`).
   - Fix: `if command -v brew >/dev/null; then brew install oven-sh/bun/bun; else curl -fsSL https://bun.sh/install | bash; fi`
     (upgrade: `brew upgrade bun` if brew-installed, else `bun upgrade`); PATH rule.
   - Re-check: `bun --version`; `factory-preflight` prints the full JSON.
2. **Global config** (`config.global`, `trilium.error`).
   - Check: `config.global=true`, `trilium.error` ≠ `no config`, `factory-config get etapiToken >/dev/null` exits 0.
   - No URL → AskUserQuestion "Trilium URL (TriliumNext ≥ 0.106)?" options `http://localhost:8080` /
     `http://localhost:37840` (desktop); others via Other. Fix: `factory-config set triliumUrl '<url>'` (strip a
     trailing `/` or `/etapi`).
   - No token → AskUserQuestion "Paste an ETAPI token via Other (Trilium → Options → ETAPI → Create new ETAPI
     token)" options `How do I create one?` (explain, ask again) / `Stop setup`. Fix: Secret rule.
   - `factory-config get dashboardPort >/dev/null 2>&1` fails → `factory-config set dashboardPort 7777`.
   - Setting `triliumUrl` or `etapiToken` in this run marks the registration stale (step 4). Re-check: preflight.
3. **Trilium version and MCP endpoint** (`trilium.ok`, `.version`, `.mcpEndpoint`, `.error`).
   - Check (preflight's probe):
     `curl -s -m 5 -H "Authorization: $(factory-config get etapiToken)" "$(factory-config get triliumUrl)/etapi/app-info"`
     → `appVersion` ≥ 0.106 (major > 0, or major 0 and minor ≥ 106); and `trilium.mcpEndpoint=true`.
   - `trilium.error` `HTTP 401`/`HTTP 403` (token refused) → ask for a new token as in step 2; re-check.
   - Other error (timeout, refused, DNS, 5xx) → show it; AskUserQuestion `Retry / Stop setup` (a new URL via
     Other, stored as in step 2); re-check.
   - Version < 0.106 → "Trilium <version> has no built-in MCP server: upgrade TriliumNext to ≥ 0.106, then re-run
     /factory:run"; Stop setup.
   - `trilium.mcpEndpoint=false` → "Enable it in Trilium: Options → AI/LLM → MCP server"; AskUserQuestion
     `Retry (enabled) / Stop setup`; re-check.
4. **Register the Trilium MCP server** (`trilium.mcpRegistered`).
   - Check: `trilium.mcpRegistered=true`, not stale (step 2), and `claude mcp get trilium 2>&1 | grep -iE '^ *(url|status):'`
     (never prints the header) shows URL `<triliumUrl>/mcp` and no failed status.
   - Else tell the user `trilium` → `<triliumUrl>/mcp` (token as Bearer header) goes into your user-scope MCP config;
     AskUserQuestion `Register / Stop setup`.
   - Fix: if `trilium.mcpRegistered=true`, first `claude mcp remove trilium -s user`; then
     `claude mcp add --scope user --transport http trilium "<triliumUrl>/mcp" --header "Authorization: Bearer <etapiToken>"`,
     writing `<triliumUrl>` as `$(factory-config get triliumUrl)` and `<etapiToken>` as `$(factory-config get etapiToken)`.
   - Re-check: `claude mcp get trilium >/dev/null 2>&1` exits 0. Remember "registered in this run" (step 8).
5. **Tools** (`tools.uv`, `graphify.installed`, `tools.superpowers`, `graphify` in your skills list).
   - Missing items, in install order: uv (`tools.uv=false`): `curl -LsSf https://astral.sh/uv/install.sh | sh` (to
     `~/.local/bin`; PATH rule); Graphify (`graphify.installed=false`): `uv tool install graphifyy` (never `uvx` or
     pip); Graphify skill (Graphify installed now, or no `graphify` skill listed): `graphify install` (user-level
     `/graphify` skill + nudge hooks).
   - Any missing → tell the user each item, command and target; one AskUserQuestion `Install all listed / Stop setup
     (I'll install them myself)`. Run in order; a failing command → show its last 20 lines, Stop setup.
   - Re-check: preflight `tools.uv=true`, `graphify.installed=true`.
   - `tools.superpowers=false` → not installable from here: tell the user to run
     `/plugin install superpowers@claude-plugins-official`; add it to the summary; continue (brainstorm needs it).
6. **Git repository** (`git.isRepo`).
   - `false` → "`<cwd>` is not a git repository; the factory needs one"; AskUserQuestion
     `Initialise git here (git init -b main) / Stop setup`. Fix: `git init -b main`. Re-check: `git.isRepo=true`.
7. **Working files and graph hooks** (`<repoPath>`).
   - Checks: dirs `<repoPath>/.factory/{worktrees,mockups,tasks,workstreams}`; `<repoPath>/.gitignore` lines
     `.factory/` and `graphify-out/` (`grep -qxF`); `graphify.gitHooks=true`.
   - Missing → tell the user the list (dirs; `.gitignore` lines + the commit below if it applies; Graphify git hooks
     in `.git/hooks`, which rebuild `graphify-out/` after commits); AskUserQuestion `Apply / Stop setup`.
   - Dirs: `mkdir -p "<repoPath>/.factory/worktrees" "<repoPath>/.factory/mockups" "<repoPath>/.factory/tasks" "<repoPath>/.factory/workstreams"`.
   - `.gitignore`: note whether `git -C "<repoPath>" status --porcelain -- .gitignore` is empty, then
     `f="<repoPath>/.gitignore"; touch "$f"; for e in .factory/ graphify-out/; do grep -qxF "$e" "$f" || { [ -n "$(tail -c1 "$f")" ] && echo >> "$f"; echo "$e" >> "$f"; }; done`.
     Commit only if lines were added, it was empty before, `git.hasCommits=true` and
     `git -C "<repoPath>" branch --show-current` is the default branch (`main`, else `master`):
     `git -C "<repoPath>" add .gitignore && git -C "<repoPath>" commit -m "chore: ignore factory working files" -- .gitignore`.
     Otherwise leave it uncommitted; say so in the summary.
   - Hooks: `cd "<repoPath>" && graphify hook install`; re-check `graphify.gitHooks=true`.
     `git -C "<repoPath>" config --get core.hooksPath` non-empty → warn: `.git/hooks` is bypassed (SOP 5 refreshes).
8. **MCP gate.** `mcp__trilium__search_notes` must be callable: in your tool list, or loaded with ToolSearch query
   `+trilium` (max_results 20).
   - Registered in this run → the stop below (still-callable tools use the old registration).
   - Callable → step 9.
   - Not callable, registered before this run (Trilium down, MCP disabled, stale token) → AskUserQuestion
     `Re-register trilium with the stored URL and token / Stop setup`; Re-register → step 4 fix, then the stop below.
   - Stop: if `mcp__trilium__*` tools were not available in this session (or `trilium` was registered in this run),
     tell the user to run `/mcp` → reconnect (or restart Claude Code) and re-run `/factory:run`; stop
     (`factory-event stage --stage setup --status stopped </dev/null`; the next run re-enters setup).
9. **Trilium notes** (`$PLUGIN_ROOT/skills/run/references/trilium-schema.md`: Hierarchy, Titles, find or create).
   A reused note keeps its content and gets its labels re-set; `Factory Log` is append-only (never `set_note_content`).
   - Root: `mcp__trilium__search_notes("#factoryRoot")`: one hit → `<rootId>`; several → AskUserQuestion, one option
     per `<noteId> <title>`; none → `mcp__trilium__get_child_notes(root)` exact title `ClaudeProjects`, else create.
   - Project: `factory.projectNoteId` whose `mcp__trilium__get_attributes` shows `#factoryProject` and `#repoPath` =
     `<repoPath>` → `<projectNoteId>`. Else `search_notes("#factoryProject #repoPath='<repoPath>'")`: one hit → use;
     several → ask as for root; none → `get_child_notes(<rootId>)` exact title `<repoName>`: no `#repoPath` → reuse;
     another `#repoPath` (moved repo or namesake) → AskUserQuestion `Re-point it to <repoPath> / Stop setup (rename
     one in Trilium first)`; absent → create.
   - Log: `get_child_notes(<projectNoteId>)` exact title `Factory Log`, else create.
   - Anything to create → tell the user titles and parents; AskUserQuestion `Create in Trilium / Stop setup`. Create
     with `mcp__trilium__create_note` (type `text`, Markdown content below; no template exists for these), then one
     `mcp__trilium__set_attribute` per label (markers empty):

     | Title | Parent | Content | Labels |
     |---|---|---|---|
     | `ClaudeProjects` | `root` | `# ClaudeProjects` + "Projects of the Claude Code factory plugin." | `#factoryRoot` |
     | `<repoName>` | `<rootId>` | `# <repoName>` + "Factory project for `<repoPath>`." | `#factoryProject`, `#repo=<repoName>`, `#repoPath=<repoPath>` (`#projectKind`: examine) |
     | `Factory Log` | `<projectNoteId>` | `# Factory Log` | `#factoryDoc=log`, `#project=<repoName>` |

   - Cache: `factory-config set projectNoteId <projectNoteId> --repo "<repoPath>"`.
10. **Dashboard** (`dashboard.running`).
    - `false` → `factory-dashboard start`; still `"running":false` (e.g. `dashboard not built`) → mention once, continue.
    - Port: `factory-config get dashboardPort 2>/dev/null || echo 7777`; `set_attribute(<projectNoteId>, dashboardPort=<port>)`.

## Completion

1. `mcp__trilium__set_attribute(<projectNoteId>, stageSetup=done)`.
2. `mcp__trilium__append_to_note(<Factory Log>, "- <ISO ts> [setup] stage done — Trilium <version>, graph hooks
   <on|off>, dashboard <port|not running>")` (never the token).
3. `factory-event stage --stage setup --status done </dev/null`; then `factory-preflight` again.
4. Print one paragraph: what this run changed (note ids), what was already in place, what the user must still do
   (`/plugin install superpowers@claude-plugins-official`, commit `.gitignore`, add `~/.local/bin` and `~/.bun/bin`
   to the shell PATH, open `http://127.0.0.1:<port>`); next stage: examine.

## Direct-command behaviour

`/factory:setup` or `/factory:run setup`:
- Runs every step even when `#stageSetup=done`: re-verifies and repairs; satisfied steps print one line.
- Step 2 also asks when config exists: AskUserQuestion `Keep Trilium settings (<triliumUrl>) / Change URL / Change
  token`; a change asks step 2's question for it, then re-runs steps 3–4 and ends at the step 8 stop.
- If "Ensure setup" already ran setup in this invocation, do not run it twice. After Completion, stop (SKILL.md).

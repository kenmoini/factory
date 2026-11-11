# Stage: setup

Idempotent checklist that readies this machine and `<repoPath>` (= `git.root`, else the cwd; `<repoName>` = its
basename). Each step: **check** (the preflight field or command named) → if unmet, tell the user what will be
installed or changed and confirm with AskUserQuestion → **fix** → **re-check** (`factory-preflight` again; decide on
the fresh JSON). A satisfied step prints one line (`setup: <step> ok — <detail>`) and asks nothing. Never install,
register or change anything without that confirmation (one question may cover several items). Track every change
for the summary.

- **Secret.** The ETAPI token never passes through you. It lives only in `<repoPath>/.mcp.json` (gitignored), where
  the user types it over the placeholder `your-etapi-token` themselves. Never ask for it, never Read, `cat` or print
  `.mcp.json`, `~/.claude.json` or `~/.config/claude-factory/config.json`, never run `claude mcp get` or `claude mcp
  list` (they print the Authorization header), never write a token into a command, Trilium, the Factory Log,
  `.factory/` or a commit. The commands below print a status word or a path, never file content.
- **`<edit>`** = print: "Open `<repoPath>/.mcp.json` and replace `your-etapi-token` with your ETAPI token (Options →
  ETAPI in Trilium), then run `/mcp` → reconnect (or restart Claude Code) and re-run `/factory:run`." (`trilium.source`
  `user`: name the `trilium` entry in `~/.claude.json` instead of `.mcp.json`.)
- **Tracked `.mcp.json`.** Before writing it: `git -C "<repoPath>" ls-files --error-unmatch .mcp.json >/dev/null 2>&1`
  exits 0 → it is committed, so a token in it would be too. Say so (untracking keeps the file here, but the ignore
  commit removes it from the repo: teammates lose the shared file); AskUserQuestion `Untrack it (git rm --cached
  .mcp.json) / Stop setup`. Fix: `git -C "<repoPath>" rm -q --cached .mcp.json`.
- **`<ignore>`** (after writing `.mcp.json` or `.claude/settings.local.json`, and in step 7). Add the lines:
  `f="<repoPath>/.gitignore"; touch "$f"; for e in .factory/ graphify-out/ .mcp.json .claude/settings.local.json; do grep -qxF "$e" "$f" || { [ -n "$(tail -c1 "$f")" ] && echo >> "$f"; echo "$e" >> "$f"; }; done`.
  Then SOP 4's working-files commit (`.gitignore`, plus `.gitattributes` once step 7's `graphify hook install` has
  written its line; files with other uncommitted changes are skipped). The questions of steps 2, 3, 4 and 7 cover it.
- **PATH.** Bash calls do not share environment: once uv or bun is installed in this run, start every later Bash
  call with `export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"; `.
- **Stop setup** (a `Stop setup` answer, or a re-check that still fails): run SOP 4's working-files commit (never leave
  `<main>` dirty); print what is missing and the user's next action; `factory-event stage --stage setup --status
  stopped </dev/null`; if `Factory Log` exists and `mcp__trilium__*` tools are available, append
  `- <ISO ts> [setup] stage stopped — <reason>`; end the whole run.

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
2. **Global config and legacy credentials** (`config.global`, `config.legacyTriliumKeys`).
   - `factory-config get dashboardPort >/dev/null 2>&1` fails → `factory-config set dashboardPort 7777`.
   - `config.legacyTriliumKeys=true` → tell the user the global config still holds the old Trilium URL and token
     (moving them gitignores `.mcp.json`, `<ignore>` commit); AskUserQuestion `Migrate them into
     <repoPath>/.mcp.json (recommended) / Leave`. Migrate → Tracked rule, then
     `factory-config migrate-trilium --repo "<repoPath>"` (moves both in-process, never printed; `"kept":true` =
     an existing real-token entry was kept), then `<ignore>`;
     `"error"` → show it, Stop setup. Leave → continue (setup and preflight no longer use them).
   - Re-check: preflight.
3. **Trilium MCP server entry** (`trilium.configured`, `.placeholder`, `.source`).
   - `configured=false` → AskUserQuestion "Trilium base URL (TriliumNext ≥ 0.106)? It goes into
     `<repoPath>/.mcp.json` as the `trilium` MCP server with a placeholder token you replace yourself; `.mcp.json` is
     gitignored (`<ignore>` commit)." options `http://localhost:8080` / `http://localhost:37840` (desktop) /
     `Stop setup`; others via Other.
   - Fix: Tracked rule; then (prints `written`, `invalid` or `exists`; `<url>` single-quoted)
     `bun -e 'const fs=require("fs"),[,p,u]=process.argv,o=v=>v&&typeof v=="object"&&!Array.isArray(v);let j={};try{if(fs.existsSync(p))j=JSON.parse(fs.readFileSync(p,"utf8"))}catch{j=0}const s=o(j)&&(j.mcpServers??={});if(!o(s)){console.log("invalid");process.exit(1)}if(s.trilium){console.log("exists");process.exit(1)}s.trilium={type:"http",url:u.trim().replace(/\/+$/,"").replace(/\/(etapi|mcp)$/,"")+"/mcp",headers:{Authorization:"Bearer your-etapi-token"}};fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n",{mode:0o600});fs.chmodSync(p,0o600);console.log("written")' "<repoPath>/.mcp.json" '<url>'`.
     `invalid` (not JSON) or `exists` (a `trilium` server without `"type": "http"` and a `url`) → the user must fix
     `.mcp.json`; Stop setup.
     Then step 4's TLS bullet now (one restart covers both); then `<ignore>`; then `<edit>`; Stop setup.
   - `placeholder=true` → `<ignore>` (say if it adds a line); `<edit>`; Stop setup.
4. **Trilium connection** (`trilium.ok`, `.error`, `.url`, `.version`, `.mcpEndpoint`). Decide on preflight only: no
   `curl` or other command with the token.
   - `ok=false` → print `trilium.url` and `trilium.error` (`HTTP 401`/`HTTP 403`: the token was refused, `<edit>` with
     a valid one) and the hint "set `FACTORY_TLS_VERIFY=1` only if you want verification; the plugin skips it by
     default"; Stop setup.
   - `trilium.version` < 0.106 (major 0 and minor < 106) → "Trilium <version> has no built-in MCP server: upgrade
     TriliumNext to ≥ 0.106, then re-run /factory:run"; Stop setup.
   - `trilium.mcpEndpoint=false` → "Enable it in Trilium: Options → AI/LLM → MCP server"; AskUserQuestion
     `Retry (enabled) / Stop setup`; re-check.
   - TLS for Claude Code's own MCP client (`https://` URLs only). Check: `grep -qE
     '"NODE_TLS_REJECT_UNAUTHORIZED": *"0"' "<repoPath>/.claude/settings.local.json" 2>/dev/null`. Unset → explain:
     unlike the plugin, Claude Code's MCP client checks certificates (a self-signed or private-CA one keeps `trilium`
     from connecting); the setting turns that off for Claude Code and all it starts in this project; AskUserQuestion `Write NODE_TLS_REJECT_UNAUTHORIZED=0 into
     <repoPath>/.claude/settings.local.json env (recommended for self-signed certs) / Skip` (gitignored, `<ignore>`
     commit). Fix (keeps other keys; prints `written` or `invalid`; then `<ignore>`):
     `bun -e 'const fs=require("fs"),[,p]=process.argv,o=v=>v&&typeof v=="object"&&!Array.isArray(v);let j={};try{if(fs.existsSync(p))j=JSON.parse(fs.readFileSync(p,"utf8"))}catch{j=0}if(!o(j)){console.log("invalid");process.exit(1)}j.env={...(o(j.env)?j.env:{}),NODE_TLS_REJECT_UNAUTHORIZED:"0"};fs.mkdirSync(require("path").dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");console.log("written")' "<repoPath>/.claude/settings.local.json"`
     (`invalid` → show it, continue without). It takes effect after Claude Code restarts: remember "TLS env written".
5. **Tools** (`tools.uv`, `graphify.installed`, `tools.superpowers`).
   - Missing items, in install order: uv (`tools.uv=false`): `curl -LsSf https://astral.sh/uv/install.sh | sh` (to
     `~/.local/bin`; PATH rule); Graphify (`graphify.installed=false`): `uv tool install graphifyy` (never `uvx` or
     pip). The factory uses only the `graphify` CLI, so `graphify install` (its user-level skill) is never run.
   - Any missing → tell the user each item, command and target; one AskUserQuestion `Install all listed / Stop setup
     (I'll install them myself)`. Run in order; a failing command → show its last 20 lines, Stop setup.
   - Re-check: preflight `tools.uv=true`, `graphify.installed=true`.
   - `tools.superpowers=false` → not installable from here: tell the user to run
     `/plugin install superpowers@claude-plugins-official`; add it to the summary; continue (brainstorm needs it).
6. **Git repository** (`git.isRepo`).
   - `false` → "`<cwd>` is not a git repository; the factory needs one"; AskUserQuestion
     `Initialise git here (git init -b main) / Stop setup`. Fix: `git init -b main`. Re-check: `git.isRepo=true`.
7. **Working files and graph hooks** (`<repoPath>`).
   - Checks: dirs `<repoPath>/.factory/{worktrees,mockups,tasks,workstreams}`; `<repoPath>/.gitignore` has the
     `<ignore>` lines (`grep -qxF`); hooks: `<hooksDir>` = output of
     `git -C "<repoPath>" rev-parse --path-format=absolute --git-path hooks` (right for linked worktrees, submodules
     and `core.hooksPath`), present = `grep -q graphify "<hooksDir>/post-commit"` (not `graphify.gitHooks`); merge
     driver: `grep -q merge=graphify "<repoPath>/.gitattributes" 2>/dev/null`; nothing pending:
     `git -C "<repoPath>" status --porcelain -- .gitignore .gitattributes` is empty; the repo has a commit
     (`git -C "<repoPath>" rev-parse -q --verify HEAD` succeeds; preflight `git.hasCommits`).
   - Missing → tell the user the list (dirs; `.gitignore` lines; Graphify git hooks in `<hooksDir>`, which rebuild
     `graphify-out/` after commits, and their `.gitattributes` merge-driver line; the working-files commit of
     `.gitignore`/`.gitattributes` if it applies, naming it the repo's first commit when there is none);
     AskUserQuestion `Apply / Stop setup`.
   - Dirs: `mkdir -p "<repoPath>/.factory/worktrees" "<repoPath>/.factory/mockups" "<repoPath>/.factory/tasks" "<repoPath>/.factory/workstreams"`.
   - Hooks first (so the commit below takes `.gitattributes` too): `cd "<repoPath>" && graphify hook install`;
     re-check with the same grep. Still absent (e.g. husky owns `core.hooksPath`) → warn once that the graph
     refreshes only via SOP 5's stale check and continue: hooks never Stop setup.
   - Then `.gitignore`: `<ignore>`; its commit is also made when the repo has no commits (`rev-parse -q --verify
     HEAD` fails), even with no line added (brainstorm cannot branch a worktree from an empty repo): the FIRST
     commit, on the unborn branch (`branch --show-current`; `main` after step 6), then the default branch `<main>`.
     Not made → leave the files uncommitted; say so in the summary.
8. **MCP gate.** `mcp__trilium__search_notes` must be callable: in your tool list, or loaded with ToolSearch query
   `+trilium` (max_results 20).
   - Callable → step 9.
   - Not callable → tell the user to run `/mcp` → reconnect `trilium` (approve the project server if Claude Code
     asks; restart Claude Code instead if `/mcp` already shows it connected or "TLS env written") and re-run
     `/factory:run`; Stop setup (the next run re-enters setup).
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
   (`/plugin install superpowers@claude-plugins-official`, commit `.gitignore`, restart Claude Code after "TLS env
   written", add `~/.local/bin` and `~/.bun/bin` to the shell PATH, open `http://127.0.0.1:<port>`); next stage:
   examine.

## Direct-command behaviour

`/factory:setup` or `/factory:run setup`:
- Runs every step even when `#stageSetup=done`: re-verifies and repairs; satisfied steps print one line.
- Step 3 also asks when `trilium.configured=true`: AskUserQuestion `Keep Trilium settings (<url>, <source>) / Change
  URL or token`; Change → tell the user to edit the `trilium` entry themselves (`url` = `<base>/mcp`, token after
  `Bearer `; file as in `<edit>`), then `/mcp` → reconnect and re-run `/factory:run`; Stop setup.
- If "Ensure setup" already ran setup in this invocation, do not run it twice. After Completion, stop (SKILL.md).

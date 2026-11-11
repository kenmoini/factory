# Standards traits

What a mature codebase settles, as questions with popular options. `set-standards` step 3 asks them (its Option
rule adds the `(current)` and `(recommended)` labels); `enforce-standards` steps 1–2 scaffold the Scaffolding line
of each answer. Grounding: the OpenSSF Scorecard checks (License, Dependency-Update-Tool, SAST, Vulnerabilities,
Pinned-Dependencies, SBOM, Signed-Releases, Security-Policy, Token-Permissions, CI-Tests, Code-Review), the OpenSSF
Best Practices badge (FLOSS licence, documented contribution process, versioned releases with notes, vulnerability
reporting answered within 14 days, automated tests with a tests-for-new-code policy, linters, static analysis),
GitHub's community profile (README, CODE_OF_CONDUCT, CONTRIBUTING, LICENSE, SECURITY, issue templates), the SLSA
v1.0 build levels (provenance; hosted, signed builds) and the Twelve-Factor App (config in the environment, logs as
streams, dev/prod parity). The tool options are the common choices in 2026 comparisons; the researcher's per-stack
recommendation may label or replace an option (Option rule).

## Conventions

- **Options** are `Label` — description. AskUserQuestion gets the label (≤ 5 words, plus the Option rule's
  `(current)`/`(recommended)`) and the description (with the verified version); `Header` is the question's header
  (≤ 12 characters). "multiSelect" = `multiSelect: true`; nothing wanted → via Other.
- **Shared files.** An item that lives inside a file another inventory row owns (the CI workflow, `Makefile`,
  `Containerfile`, `README.md`, `.gitignore`, Q8's release workflow) extends that row's Desired, present check and
  draft instead of being a row of its own; README additions go inside existing sections too. `Makefile` `.PHONY`
  = `lint test build` plus every target named here (`setup`).
- **No manifest edits.** Scaffolding never edits a package manifest or lockfile. A tool that needs a package
  (husky, lint-staged, commitlint, semantic-release, changesets, coverage providers) gets its config files; its
  install command goes into README `## Development` and the Enforcement Plan's Risks.
- **"builders apply"** = a convention the builder and code-reviewer read from the Standards (no file).
  **"plan applies"** = a feature the plan stage turns into tasks (no file; `stages/plan.md` step 2).
- **Platform.** `.github/…` paths assume GitHub Actions. GitLab CI: jobs in `.gitlab-ci.yml` (the CI row),
  `.gitlab/issue_templates/*.md`, `.gitlab/merge_request_templates/Default.md`, root `CODEOWNERS`. CI `None yet` or
  `Makefile only` → no workflow rows; the plan's Risks list what was skipped.
- **Placeholders.** `<CONTACT>` (a reporting address) and `@OWNER` (a code-owner handle) are written when the
  Standards give none (`gh api user -q .login` fills `@OWNER` when `gh` is logged in); each one is a Risk line.
- A Standards section whose first word is `n/a`, `none`, `No` or `Nothing` produces no row. `<tool>` = the
  research recommendation for the question's research area. Present checks run in `<repoPath>`; "file exists" =
  `test -e`.

## Calls

A: Q1 (its preamble tells the user once: type `Stop` via Other on any question to stop) · B: Q2–Q5 · C: Q6–Q9 ·
D: Q10–Q13 · E: Q14–Q16 (Q16 only when applicable).

## Questions

### Q1 Runtime, versions and lint/test/build tools
- Header `Stack` · sections `runtimes`, `style`, `testing` · research `runtime`, `lint`, `test`, `build` ·
  examination: Maturity
- Options: the research's runtime + lint + test + build choices as one option (description: the four tools with
  versions); one or two alternative stacks from the report
- Scaffolding: none here (the commands become `#lintCmd`, `#testCmd`, `#buildCmd`; the Makefile is Q3's)

### Q2 API documentation
- Header `API docs` · section `api_docs` · research `api-docs`
- Options: `OpenAPI 3.1` — `docs/openapi.yaml`; `No API`; `GraphQL or protobuf` — SDL or `.proto` files;
  `AsyncAPI 3` — event-driven APIs
- Scaffolding: none (the api-design stage writes the documents)

### Q3 CI platform
- Header `CI` · section `pipelines` · research `ci` · examination: CI
- Options: `GitHub Actions` — plus a local Makefile (default); `None yet`; `Makefile only` — no hosted CI;
  `GitLab CI` — plus a local Makefile
- Scaffolding: `Makefile` (targets lint, test, build) and the platform's workflow, per enforce-standards step 1

### Q4 Build artifacts (multiSelect)
- Header `Artifacts` · section `artifacts` · research `artifacts`
- Options: `Container image` — `Containerfile`; `Standalone binary`; `Registry package`; `Helm chart`
- Scaffolding: `Containerfile` + `.containerignore`; `charts/<repoName>/`, per enforce-standards step 1

### Q5 Pipelines (multiSelect)
- Header `Pipelines` · sections `pipelines`, `dependencies` · research `pipelines` · via Other: the opt-in
  post-merge smoke (`#postMergeSmoke=true` runs `#testCmd` on `<main>` after each task merge; off by default)
- Options: `PR checks` — lint, test and build on every pull request; `Dependency updates` — Dependabot or Renovate,
  weekly (per research); `Publish artifacts` — the image or chart is published to a registry by the release
  workflow (Q8 decides when releases happen)
- Scaffolding: CI jobs; `.github/dependabot.yml` or `renovate.json` (enforce-standards step 1); `Publish artifacts`
  extends Q8's release workflow with a publish job (shared file)

### Q6 Public docs
- Header `Public docs` · section `public_docs` · research `public-docs` · examination: Docs
- Options: `Markdown in docs/` — no site; `None`; `Docusaurus`; `MkDocs Material`
- Scaffolding: the generator's config + `docs/index.md`, per enforce-standards step 1

### Q7 Licence
- Header `Licence` · section `licence` · research: none · examination: Traits "Licence" (Scorecard License; badge
  FLOSS licence; community profile LICENSE)
- Options: `MIT`; `Apache-2.0`; `Proprietary` — all rights reserved, no LICENSE file; `GPL-3.0-or-later`; via
  Other: AGPL-3.0, MPL-2.0, BSD-3-Clause, the copyright holder's name, or `undecided`
- Scaffolding: `LICENSE` = the SPDX licence's standard text, current year, holder from the Standards, else
  `git config user.name`; present = file exists and its first lines name that licence; a `LICENSE` naming another
  licence → one `update` row whose draft replaces the whole file, listed under Risks. Proprietary → no file; the
  README `## License` section says so. `undecided` → a `keep` row with Desired `not chosen` and a Risk line.

### Q8 Commits, versioning and releases
- Header `Releases` · section `releases` · research `release` · examination: Traits "Commits, versioning and
  releases" (badge: unique version per release, release notes). Every option keeps Conventional Commits, which the
  factory's agents write anyway.
- Options: `release-please` — a release PR maintains CHANGELOG.md, SemVer tags and GitHub releases from the
  commits; any language; `semantic-release` — publishes on every push to `<main>`, no human gate; Node-centric;
  `Changesets` — change notes written in PRs; JS monorepos; `Manual releases` — tags and CHANGELOG.md (Keep a
  Changelog) by hand
- Scaffolding: the commit-message check (commitlint, or pre-commit's `conventional-pre-commit`) in Q9's manager;
  Q9 `None` → a CI job on the PR's commits (shared file). The tool's config: `release-please-config.json` +
  `.release-please-manifest.json`; `.releaserc.json`; `.changeset/config.json`; `.goreleaser.yaml` (per research);
  present = the config file exists. The release workflow `.github/workflows/release.yml` (GitLab: a `release` job)
  runs the tool; `Manual releases` → `CHANGELOG.md` with the Keep a Changelog header and an `## [Unreleased]`
  section (present = file exists), and `release.yml` is created only when Q5 `Publish artifacts` or Q11 SBOM or
  signing needs it, triggered by tags `v*`.

### Q9 Git hooks
- Header `Git hooks` · section `hooks` · research `hooks` · examination: Traits "Git hooks" (badge: linters
  enabled; fast local feedback before CI)
- Options: `husky + lint-staged` — Node projects; `lefthook` — any stack; one binary, parallel hooks;
  `pre-commit` — Python-centric hook catalogue; CI parity via `run --all-files`; `None` — checks run in CI only
- Scaffolding: the chosen manager's config (`.husky/pre-commit` + `.lintstagedrc.json`; `lefthook.yml`;
  `.pre-commit-config.yaml`) running the Standards' lint (and formatter) on staged files at `pre-commit`,
  `#testCmd` at `pre-push`, Q8's commit-message check and Q10's gitleaks hook when chosen; present = the chosen
  manager's file exists; another manager's file present → `delete` row. Install command → README `## Development`.
  Risk line: husky and lefthook can take over the hooks path; the graph stage re-installs graphify's hooks when
  `graphify hook status` reports them missing (SOP 5).

### Q10 Security scanning (multiSelect)
- Header `Security` · section `security` · research `security` · examination: Traits "Security scanning"
  (Scorecard SAST, Vulnerabilities, Token-Permissions, Dangerous-Workflow; badge static analysis, no leaked
  credentials)
- Options: `SAST` — CodeQL on GitHub (private repos need GitHub Code Security), else Semgrep; `Secret scanning` —
  gitleaks in Q9's hook and in CI; `Dependency vulnerabilities` — osv-scanner, or the ecosystem's audit command;
  `Image scan` — Trivy builds the Containerfile and scans it; listed only when Q4 includes `Container image`
- Scaffolding: `.github/workflows/security.yml`, one job per chosen scanner, least-privilege `permissions:`, on
  pull_request and a weekly schedule (GitLab: jobs in the CI row); present = the workflow names the scanner. The
  gitleaks hook extends Q9's config (shared file).

### Q11 Supply chain (multiSelect)
- Header `Supply chain` · section `supply_chain` · research `supply-chain` · examination: Traits "Supply chain"
  (Scorecard Pinned-Dependencies, SBOM, Signed-Releases, Packaging; SLSA build L1–L3; CISA SBOM minimum elements)
- Options: `Frozen installs` — the lockfile is tracked; CI and the Makefile `setup` target install from it
  (`npm ci`, `uv sync --frozen`, …); `Pinned actions and images` — `uses:` and `FROM` pinned to a version or
  digest; `SBOM per release` — syft → CycloneDX or SPDX, attached by the release workflow; `Signed provenance` —
  Sigstore cosign or GitHub artifact attestations (SLSA build L2+; private repos need GitHub Enterprise Cloud for
  attestations)
- Scaffolding: all shared files: the install command in the CI row and the Makefile `setup` target; pinned
  `uses:` lines in every workflow row and `FROM` in the Containerfile row; `sbom` and `attest` steps in Q8's
  release workflow (created on tag when Q8 is `Manual releases`). Lockfile missing or untracked → no row; Risk line
  with the install command to run and commit.

### Q12 Test policy and coverage (multiSelect)
- Header `Tests` · section `test_policy` · research `coverage` · examination: Traits "Test policy and coverage"
  (badge: automated test suite, policy requiring tests for new functionality; Scorecard CI-Tests)
- Options: `Tests per change` — every change ships tests; the code-reviewer flags untested new code (builders
  apply); `Coverage reported` — `<tool>` runs in the CI test job and prints the summary; `Coverage gate` — CI
  fails below a threshold: the one already configured (the Traits row), else 80% (another number via Other);
  `End-to-end suite` — Playwright, Testcontainers or the stack's equivalent, built as tasks
  (plan applies)
- Scaffolding: `<tool>`'s config (threshold included for `Coverage gate`) and a coverage step in the CI row
  (shared file); present = the config exists and, for the gate, names the threshold.

### Q13 Repository files (multiSelect)
- Header `Repo files` · section `repo_files` · research: none · examination: Traits "Repository files" (community
  profile; Scorecard Security-Policy, Code-Review; badge contribution process, vulnerability reporting)
- Options: `Contributing + conduct` — `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md` (Contributor Covenant, latest
  release); `SECURITY.md` — how to report a vulnerability; first response within 14 days; `CODEOWNERS` — review
  ownership per path; `Issue and PR templates`
- Scaffolding: `CONTRIBUTING.md` (the Standards' commands, the commit convention, Q9's hook install, how to run
  the tests); `CODE_OF_CONDUCT.md` (contact `<CONTACT>` unless given); `SECURITY.md` (supported versions; the
  channel: GitHub private vulnerability reporting for public GitHub repos, else `<CONTACT>`; the response time);
  `.github/CODEOWNERS` (`* @OWNER` unless the Standards name owners); `.github/ISSUE_TEMPLATE/bug.yml`,
  `feature.yml`, `.github/PULL_REQUEST_TEMPLATE.md` (checklist: tests, docs, changelog). Present = file exists.

### Q14 Developer environment
- Header `Dev env` · section `dev_env` · research `dev-env` · examination: Traits "Developer environment"
  (badge: working build system; Twelve-Factor dev/prod parity)
- Options: `EditorConfig + pins` — `.editorconfig` and toolchain pins (`mise.toml`, `.tool-versions` or `.nvmrc`,
  per research); `Dev container` — `.devcontainer/devcontainer.json` on top of the pins; `Nix or devbox` —
  `flake.nix`, or `devbox.json` when the answer says devbox; `README only`
- Scaffolding: `.editorconfig` (root = true, utf-8, lf, final newline, indent per the Standards' style); the pin
  file with the Standards' runtime versions; `.devcontainer/devcontainer.json` (the stack's image, the pinned
  versions, a post-create install); `flake.nix` or `devbox.json`. Present = file exists.

### Q15 Architecture decisions
- Header `Decisions` · section `decisions_docs` · research: none · examination: Traits "Architecture decisions"
- Options: `ADRs` — `docs/adr/` with the MADR template; `ARCHITECTURE.md` — one overview file; `Both`; `None` —
  decisions stay in Trilium
- Scaffolding: `docs/adr/0001-record-architecture-decisions.md` + `docs/adr/template.md` (MADR);
  `ARCHITECTURE.md` (the Goal's first paragraph, the graph report's hubs and entry points). Present = file exists.

### Q16 Runtime operations (multiSelect; services only)
- Applicability: ask when the Goal's deliverable is long-running or request-serving (server, API, web app,
  worker, bot, daemon, serverless function); for a library, CLI, plugin or desktop app fill the section with
  `n/a (not a service)` and do not ask.
- Header `Operations` · section `operations` · research: none · examination: Traits "Runtime operations"
  (Twelve-Factor config, logs, disposability)
- Options: `Env config` — configuration from the environment; `.env.example` committed, `.env` ignored, secrets
  never in the repo; `JSON logs` — structured logs to stdout (builders apply); `Health endpoints` — health and
  readiness endpoints (plan applies); `OpenTelemetry` — traces and metrics (plan applies)
- Scaffolding: `.env.example` (every variable the Goal and Standards name, placeholder values) and `.env` in the
  `.gitignore` row (shared file); present = file exists.

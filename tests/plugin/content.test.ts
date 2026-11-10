import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseFrontmatter } from "./frontmatter";

// ---------- shared helpers ----------
const ROOT = join(import.meta.dir, "..", "..");
const abs = (rel: string) => join(ROOT, rel);
const read = (rel: string) => readFileSync(abs(rel), "utf8");

const SKILLS = ["run", "setup", "examine", "set-standards", "enforce-standards", "brainstorm", "uiux", "api-design", "plan", "validate", "execute", "graph"];
const AGENTS = ["spec-writer", "builder", "security-reviewer", "ux-reviewer", "ui-design-reviewer", "code-reviewer", "approver", "codebase-examiner", "standards-researcher", "plan-adversary"];
const STAGES = SKILLS.filter((s) => s !== "run");
const MODELS = ["fable", "opus", "sonnet", "haiku", "inherit"];
const FORBIDDEN_AGENT_KEYS = ["hooks", "mcpServers", "permissionMode"];

/** Label-like tokens that are not Trilium labels (C-ish false positives). Extend as needed. */
export const LABEL_ALLOWLIST = ["include", "if", "endif", "define", "pragma"];

/** Recursively list files under a repo-relative dir (repo-relative paths); [] if dir is missing. */
function walk(dir: string): string[] {
  if (!existsSync(abs(dir))) return [];
  return readdirSync(abs(dir)).flatMap((name) => {
    const rel = join(dir, name);
    return statSync(abs(rel)).isDirectory() ? walk(rel) : [rel];
  });
}
const mdIn = (dir: string, deep = false) =>
  (deep ? walk(dir) : existsSync(abs(dir)) ? readdirSync(abs(dir)).map((n) => join(dir, n)) : []).filter((f) => f.endsWith(".md") && statSync(abs(f)).isFile());

const skillDirs = () =>
  existsSync(abs("skills")) ? readdirSync(abs("skills")).filter((d) => statSync(abs(join("skills", d))).isDirectory()).sort() : [];
const skillFiles = () => skillDirs().map((d) => `skills/${d}/SKILL.md`);
const agentFiles = () => mdIn("agents");
const fm = (rel: string) => parseFrontmatter(read(rel));
const missing = (want: string[], have: string[]) => want.filter((x) => !have.includes(x));
/** skills/run/ exists from Task 11 (references, templates); the skill rules start once SKILL.md lands (Task 12). */
const NO_RUN_SKILL = !existsSync(abs("skills/run/SKILL.md"));

// ---------- rule 1: skill frontmatter ----------
test.skipIf(NO_RUN_SKILL)("skills: SKILL.md exists per dir, name === dir, non-empty description", () => {
  const problems: string[] = [];
  for (const d of skillDirs()) {
    const f = `skills/${d}/SKILL.md`;
    if (!existsSync(abs(f))) { problems.push(`${f}: missing`); continue; }
    const { data } = fm(f);
    if (data.name !== d) problems.push(`${f}: name ${JSON.stringify(data.name)} !== dir "${d}"`);
    if (typeof data.description !== "string" || !data.description.trim()) problems.push(`${f}: description missing or empty`);
  }
  expect(problems, problems.join("\n")).toEqual([]);
});

test.skipIf(NO_RUN_SKILL)("skills: the set of skill dirs equals the 12 expected", () => {
  const have = skillDirs();
  const msg = `missing: [${missing(SKILLS, have)}] unexpected: [${missing(have, SKILLS)}]`;
  expect([...have].sort(), msg).toEqual([...SKILLS].sort());
});

// ---------- rule 2: alias skills ----------
test("skills: alias skills (all but run) are disable-model-invocation and mention factory:run", () => {
  const problems: string[] = [];
  for (const f of skillFiles().filter((f) => f !== "skills/run/SKILL.md" && existsSync(abs(f)))) {
    const { data, body } = fm(f);
    if (data["disable-model-invocation"] !== true) problems.push(`${f}: disable-model-invocation must be true`);
    if (!body.includes("factory:run")) problems.push(`${f}: body must contain "factory:run"`);
  }
  expect(problems, problems.join("\n")).toEqual([]);
});

// ---------- rule 3: agents ----------
test("agents: frontmatter valid, no hooks/mcpServers/permissionMode, no mcp__", () => {
  const problems: string[] = [];
  for (const f of agentFiles()) {
    const text = read(f);
    const { data } = parseFrontmatter(text);
    const name = f.replace(/^agents\//, "").replace(/\.md$/, "");
    if (data.name !== name) problems.push(`${f}: name ${JSON.stringify(data.name)} !== filename "${name}"`);
    if (typeof data.description !== "string" || !data.description.trim()) problems.push(`${f}: description missing or empty`);
    if (typeof data.model !== "string" || !MODELS.includes(data.model)) problems.push(`${f}: model ${JSON.stringify(data.model)} not in {${MODELS}}`);
    const tools = data.tools;
    if (tools === undefined || tools === "" || (Array.isArray(tools) && tools.length === 0)) problems.push(`${f}: tools missing or empty`);
    for (const k of FORBIDDEN_AGENT_KEYS) if (k in data) problems.push(`${f}: forbidden frontmatter key "${k}"`);
    if (text.includes("mcp__")) problems.push(`${f}: contains forbidden "mcp__"`);
  }
  expect(problems, problems.join("\n")).toEqual([]);
});

test.skipIf(!existsSync(abs("agents")))("agents: the set of agent files equals the 10 expected", () => {
  const have = agentFiles().map((f) => f.replace(/^agents\//, "").replace(/\.md$/, ""));
  const msg = `missing: [${missing(AGENTS, have)}] unexpected: [${missing(have, AGENTS)}]`;
  expect([...have].sort(), msg).toEqual([...AGENTS].sort());
});

// ---------- rule 4: referenced plugin paths exist ----------
function checkPaths(files: string[], re: RegExp): string[] {
  const problems: string[] = [];
  for (const f of files) {
    for (const m of read(f).matchAll(re)) {
      const rel = m[1].replace(/`/g, "").replace(/[.,:;)]+$/, "");
      if (!existsSync(abs(rel))) problems.push(`${f}: references nonexistent "${rel}"`);
    }
  }
  return problems;
}
test("paths: ${CLAUDE_PLUGIN_ROOT}/<rel> in SKILL.md and agents exist", () => {
  const files = [...skillFiles().filter((f) => existsSync(abs(f))), ...agentFiles()];
  const problems = checkPaths(files, /\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9_./-]+)/g);
  expect(problems, problems.join("\n")).toEqual([]);
});
test("paths: $PLUGIN_ROOT/<rel> in skills/run/**/*.md exist", () => {
  const problems = checkPaths(mdIn("skills/run", true), /\$PLUGIN_ROOT\/([A-Za-z0-9_./-]+)/g);
  expect(problems, problems.join("\n")).toEqual([]);
});

// ---------- rule 5: run skill references every stage ----------
test.skipIf(NO_RUN_SKILL)("run: SKILL.md mentions each stages/<s>.md and each exists", () => {
  const body = read("skills/run/SKILL.md");
  const problems: string[] = [];
  for (const s of STAGES) {
    if (!body.includes(`stages/${s}.md`)) problems.push(`skills/run/SKILL.md: does not mention stages/${s}.md`);
    if (!existsSync(abs(`skills/run/stages/${s}.md`))) problems.push(`skills/run/stages/${s}.md: missing`);
  }
  expect(problems, problems.join("\n")).toEqual([]);
});

// ---------- rule 6: label drift ----------
/** Usage regex (not preceded by word char, backtick or #). */
const USED_LABEL_RE = () => /(?<![\w`#])#([a-z][A-Za-z0-9]*)(?![A-Za-z0-9])/g;
/** Labels declared in the schema: exact tokens, backticks allowed before the #. */
export function declaredLabels(schema: string): Set<string> {
  return new Set([...schema.matchAll(/(?<![\w#])#([a-z][A-Za-z0-9]*)(?![A-Za-z0-9])/g)].map((m) => m[1]));
}
test("labels: declaredLabels matches exact tokens only", () => {
  const d = declaredLabels("`#statusReason` and #kind.");
  expect(d.has("status")).toBe(false);
  expect(d.has("statusReason")).toBe(true);
  expect(d.has("kind")).toBe(true);
});
test("labels: every #label used in stages/refs/agents is defined in trilium-schema.md", () => {
  const files = [
    ...mdIn("skills/run/stages"),
    ...["sop", "agent-protocol", "execute-loop"].map((n) => `skills/run/references/${n}.md`).filter((f) => existsSync(abs(f))),
    ...agentFiles(),
  ];
  const used = new Map<string, string[]>();
  for (const f of files) {
    for (const m of read(f).matchAll(USED_LABEL_RE())) {
      if (LABEL_ALLOWLIST.includes(m[1])) continue;
      used.set(m[1], [...new Set([...(used.get(m[1]) ?? []), f])]);
    }
  }
  if (used.size === 0) return;
  const schemaPath = "skills/run/references/trilium-schema.md";
  expect(existsSync(abs(schemaPath)), `${schemaPath} is missing but labels are used: ${[...used.keys()].map((l) => "#" + l).join(", ")}`).toBe(true);
  const declared = declaredLabels(read(schemaPath));
  const problems = [...used].filter(([l]) => !declared.has(l)).map(([l, fs]) => `#${l} (used in ${fs.join(", ")}) not defined in ${schemaPath}`);
  expect(problems, problems.join("\n")).toEqual([]);
});

// ---------- rule 7: size budgets ----------
test("size budgets: SKILL.md/references/stages/agents within limits", () => {
  const budgets: [string[], number][] = [
    [existsSync(abs("skills/run/SKILL.md")) ? ["skills/run/SKILL.md"] : [], 16_000],
    [mdIn("skills/run/references"), 24_000],
    [mdIn("skills/run/stages"), 16_000],
    [agentFiles(), 8_000],
  ];
  const problems: string[] = [];
  for (const [files, max] of budgets)
    for (const f of files) {
      const n = readFileSync(abs(f)).length;
      if (n > max) problems.push(`${relative(ROOT, abs(f))}: ${n} chars > ${max}`);
    }
  expect(problems, problems.join("\n")).toEqual([]);
});

// ---------- rule 8: templates ----------
const TEMPLATES = ["goal", "examination", "standards", "enforcement-plan", "overview", "uiux-spec", "api-design", "task-spec", "build-report", "review", "approval", "validation", "human-decision"];
test("templates: set equals the 13 expected; '# ' title on line 1, factoryDoc comment on line 2", () => {
  const files = mdIn("skills/run/templates");
  const have = files.map((f) => f.replace(/^skills\/run\/templates\//, "").replace(/\.md$/, ""));
  const problems: string[] = [];
  if ([...have].sort().join() !== [...TEMPLATES].sort().join()) problems.push(`templates: missing: [${missing(TEMPLATES, have)}] unexpected: [${missing(have, TEMPLATES)}]`);
  for (const f of files) {
    const [l1 = "", l2 = ""] = read(f).split("\n");
    if (!l1.startsWith("# ")) problems.push(`${f}: line 1 must be a "# " title`);
    if (!/^<!-- factoryDoc: [a-z-]+ -->$/.test(l2)) problems.push(`${f}: line 2 must be "<!-- factoryDoc: <kind> -->"`);
  }
  expect(problems, problems.join("\n")).toEqual([]);
});

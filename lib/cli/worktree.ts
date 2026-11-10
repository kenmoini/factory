import { ForeignBranchError, ensureWorktree, removeWorktree, validateSlug } from "../worktree";

const argv = process.argv.slice(2);
let repo = process.cwd();
let base: string | undefined;
let adopt = false;
let deleteBranch = false;
const pos: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--repo") repo = argv[++i];
  else if (argv[i] === "--base") base = argv[++i];
  else if (argv[i] === "--adopt") adopt = true;
  else if (argv[i] === "--delete-branch") deleteBranch = true;
  else pos.push(argv[i]);
}
const [cmd, slug] = pos;

if ((cmd !== "ensure" && cmd !== "remove") || !slug) {
  console.error("usage: factory-worktree ensure <slug> [--adopt] [--base <ref>] [--repo <dir>] | remove <slug> [--delete-branch] [--repo <dir>]");
  process.exit(1);
}

const fail = (code: number, msg: string): never => {
  console.error(msg);
  console.log(JSON.stringify({ error: msg }));
  process.exit(code);
};

const bad = validateSlug(slug);
if (bad) fail(3, bad);

try {
  const result = cmd === "ensure" ? await ensureWorktree(repo, slug, { adopt, baseRef: base }) : await removeWorktree(repo, slug, { deleteBranch });
  console.log(JSON.stringify(result));
} catch (e) {
  fail(e instanceof ForeignBranchError ? 2 : 1, e instanceof Error ? e.message : String(e));
}

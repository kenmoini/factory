import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { git } from "./git";

export async function buildReviewPackage(opts: {
  worktree: string;
  base: string;
  head: string;
  outFile: string;
  context?: number;
}): Promise<{ path: string; commits: number; filesChanged: number }> {
  const { worktree, base, head, outFile } = opts;
  const context = opts.context ?? 10;
  const range = `${base}..${head}`;
  const invalid = () => new Error(`invalid range: ${range}`);

  for (const rev of [base, head]) {
    if ((await git(worktree, "rev-parse", "--verify", "--quiet", `${rev}^{commit}`)).code !== 0) throw invalid();
  }
  if ((await git(worktree, "merge-base", "--is-ancestor", base, head)).code !== 0) throw invalid();

  const [log, stat, diff, names, count] = await Promise.all([
    git(worktree, "log", "--format=%h %s", range),
    git(worktree, "diff", "--stat", range),
    git(worktree, "diff", `-U${context}`, range),
    git(worktree, "diff", "--name-only", range),
    git(worktree, "rev-list", "--count", range),
  ]);
  for (const r of [log, stat, diff, names, count]) if (r.code !== 0) throw new Error(`git failed for ${range}: ${r.err}`);

  const md = [
    "# Review package",
    "",
    `Range: ${range}`,
    "",
    "## Commits",
    log.out || "(none)",
    "",
    "## Stat",
    stat.out,
    "",
    "## Diff",
    "```diff",
    diff.out,
    "```",
    "",
  ].join("\n");

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, md);
  return { path: outFile, commits: Number(count.out), filesChanged: names.out ? names.out.split("\n").length : 0 };
}

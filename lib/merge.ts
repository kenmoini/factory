import { defaultBranch, git } from "./git";

export type MergeResult =
  | { result: "merged"; sha: string }
  | { result: "up-to-date" }
  | { result: "conflict"; files: string[] }
  | { result: "dirty"; files: string[] }
  | { result: "error"; message: string };

export async function mergeBranch(opts: { repoDir: string; branch: string; message: string; into?: string }): Promise<MergeResult> {
  const { repoDir, branch, message } = opts;
  const into = opts.into ?? (await defaultBranch(repoDir));

  const exists = await git(repoDir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
  if (exists.code !== 0) return { result: "error", message: `no such branch: ${branch}` };

  const st = await git(repoDir, "status", "--porcelain");
  if (st.code !== 0) return { result: "error", message: st.err || "git status failed" };
  // git() trims output, which can eat the first line's leading status space; strip 1-2 status chars + space.
  if (st.out) return { result: "dirty", files: st.out.split("\n").map((l) => l.replace(/^[ MADRCU?!]{1,2} /, "")) };

  const cur = await git(repoDir, "rev-parse", "--abbrev-ref", "HEAD");
  if (cur.code !== 0) return { result: "error", message: cur.err || "cannot determine current branch" };
  if (cur.out !== into) {
    const co = await git(repoDir, "checkout", into);
    if (co.code !== 0) return { result: "error", message: co.err || `checkout ${into} failed` };
  }

  const m = await git(repoDir, "merge", "--no-ff", "-m", message, branch);
  if (m.code === 0) {
    if (m.out.includes("Already up to date")) return { result: "up-to-date" };
    const head = await git(repoDir, "rev-parse", "HEAD");
    if (head.code !== 0) return { result: "error", message: head.err || "rev-parse HEAD failed" };
    return { result: "merged", sha: head.out };
  }

  const d = await git(repoDir, "diff", "--name-only", "--diff-filter=U");
  const files = d.code === 0 && d.out ? d.out.split("\n") : [];
  const ab = await git(repoDir, "merge", "--abort");
  if (ab.code !== 0) {
    return { result: "error", message: `merge failed: ${m.err || m.out}; abort failed: ${ab.err || ab.out}` };
  }
  return { result: "conflict", files };
}

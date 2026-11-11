import type { CommitFile, RepoCommit, TaskRef } from "../shared/types";

export interface Ref { name: string; sha: string; kind: "branch" | "tag" }
export interface Worktree { path: string; head: string; branch?: string; detached: boolean; bare: boolean }
export interface RawCommit { sha: string; parents: string[]; subject: string; author: string; authorTs: string; trailerTasks: string[] }

/** `git log --format` string whose output `parseLog` reads. */
export const LOG_FORMAT = "%H%x1f%P%x1f%s%x1f%an%x1f%aI%x1f%(trailers:key=Task,valueonly,separator=%x1d)%x1e";

/** `for-each-ref --format='%(refname)%x1f%(objectname)%x1f%(*objectname)' refs/heads refs/tags`; annotated tags use the peeled commit. */
export function parseRefs(out: string): Ref[] {
  const refs: Ref[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [full, sha, peeled] = line.split("\x1f");
    const kind = full.startsWith("refs/heads/") ? "branch" : full.startsWith("refs/tags/") ? "tag" : null;
    if (!kind) continue;
    refs.push({ name: full.slice(kind === "branch" ? 11 : 10), sha: peeled || sha, kind });
  }
  return refs;
}

/** `git worktree list --porcelain`. */
export function parseWorktrees(out: string): Worktree[] {
  const list: Worktree[] = [];
  for (const block of out.split(/\n\s*\n/)) {
    let path = "", head = "", branch: string | undefined, detached = false, bare = false;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice(9);
      else if (line.startsWith("HEAD ")) head = line.slice(5);
      else if (line.startsWith("branch ")) branch = line.slice(7).replace(/^refs\/heads\//, "");
      else if (line === "detached") detached = true;
      else if (line === "bare") bare = true;
    }
    if (!path) continue;
    const wt: Worktree = { path, head: bare ? "" : head, detached, bare };
    if (branch !== undefined) wt.branch = branch;
    list.push(wt);
  }
  return list;
}

/** Records of `git log --format=LOG_FORMAT`: split on \x1e, fields on \x1f, trailers on \x1d. */
export function parseLog(out: string): RawCommit[] {
  const commits: RawCommit[] = [];
  for (const rec of out.split("\x1e")) {
    const text = rec.trim();
    if (!text) continue;
    const [sha, parents = "", subject = "", author = "", authorTs = "", trailers = ""] = text.split("\x1f");
    commits.push({ sha, parents: parents.split(" ").filter(Boolean), subject, author, authorTs, trailerTasks: trailers.split("\x1d").filter(Boolean) });
  }
  return commits;
}

/** Task refs from `Task:` trailer values (`slug/T-001`) and a `Merge slug: T-001 …` subject, deduplicated, subject first. */
export function taskRefsOf(subject: string, trailerTasks: string[]): TaskRef[] {
  const seen = new Set<string>();
  const refs: TaskRef[] = [];
  const add = (slug: string, taskId: string) => {
    const key = `${slug}/${taskId}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ slug, taskId });
  };
  const m = /^Merge ([a-z0-9][a-z0-9-]*): (T-\d{3,})\b/.exec(subject);
  if (m) add(m[1], m[2]);
  for (const t of trailerTasks) {
    const v = /^([a-z0-9][a-z0-9-]*)\/(T-\d{3,})$/.exec(t.trim());
    if (v) add(v[1], v[2]);
  }
  return refs;
}

/** Number of entries in `git status --porcelain=v1`. */
export function parseStatusCount(out: string): number {
  return out.split("\n").filter((l) => l.trim() !== "").length;
}

/** `git show --numstat` lines; `-` counts mark a binary file. */
export function parseNumstat(out: string): CommitFile[] {
  const files: CommitFile[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const a = line.indexOf("\t");
    const b = a < 0 ? -1 : line.indexOf("\t", a + 1);
    if (b < 0) continue;
    const added = line.slice(0, a), deleted = line.slice(a + 1, b), path = line.slice(b + 1);
    if (added === "-" || deleted === "-") files.push({ path, added: 0, deleted: 0, binary: true });
    else files.push({ path, added: Number(added) || 0, deleted: Number(deleted) || 0 });
  }
  return files;
}

/** `rev-list --left-right --count <branch>...<base>`: "ahead\tbehind". */
export function parseAheadBehind(out: string): { ahead: number; behind: number } {
  const [a, b] = out.trim().split(/\s+/);
  return { ahead: Number(a) || 0, behind: Number(b) || 0 };
}

/** A raw log record as a `RepoCommit`, with the branches and tags whose tip it is. */
export function toRepoCommit(raw: RawCommit, tips: Map<string, { branches: string[]; tags: string[] }>): RepoCommit {
  const tip = tips.get(raw.sha);
  return {
    sha: raw.sha, short: raw.sha.slice(0, 7), parents: raw.parents, subject: raw.subject, author: raw.author, authorTs: raw.authorTs,
    branches: tip?.branches ?? [], tags: tip?.tags ?? [], tasks: taskRefsOf(raw.subject, raw.trailerTasks), isMerge: raw.parents.length > 1,
  };
}

/** Hex hash of the refs and worktree states; changes when any ref, head or dirty count does. */
export function fingerprintOf(refs: Ref[], worktrees: { path: string; head: string; dirty: number }[]): string {
  const lines = [...refs.map((r) => `${r.name} ${r.sha}`), ...worktrees.map((w) => `${w.path} ${w.head} ${w.dirty}`)].sort();
  return Bun.hash(lines.join("\n")).toString(16);
}

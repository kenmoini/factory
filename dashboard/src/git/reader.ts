import { existsSync } from "node:fs";
import type { CommitDetail, RepoBranch, RepoSnapshot } from "../shared/types";
import { LOG_FORMAT, fingerprintOf, parseAheadBehind, parseLog, parseNumstat, parseRefs, parseStatusCount, parseWorktrees, toRepoCommit } from "./parse";
import type { RawCommit, Ref, Worktree } from "./parse";

export type GitRunner = (args: string[], cwd: string, opts?: { timeoutMs?: number; env?: Record<string, string>; maxOut?: number }) => Promise<{ code: number; out: string; err: string }>;
export const GIT_TIMEOUT_MS = 10_000;
export const GIT_MAX_OUT = 8 * 1024 * 1024;
/** Most `rev-list` (ahead/behind) processes one `build` runs at once. */
export const AHEAD_BEHIND_POOL = 4;

/** A live worktree (not bare, folder present) with its number of changed or untracked entries. */
export interface ProbedWorktree extends Worktree { dirty: number }
/** The cheap part of a snapshot, read on every poll: refs, live worktrees with dirty counts, and their fingerprint. */
export interface RepoProbe { fingerprint: string; refs: Ref[]; worktrees: ProbedWorktree[] }

/** Runs git without a shell; never throws. Timeout → code 124, output over `opts.maxOut` (default `GIT_MAX_OUT`) → 125 (git is killed), spawn failure → 127. */
export const runGit: GitRunner = async (args, cwd, opts) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["git", "--no-pager", "-c", "core.quotepath=false", ...args], {
      cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...opts?.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
  } catch (e) {
    return { code: 127, out: "", err: e instanceof Error ? e.message : String(e) };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  // a killed git can leave a child (an editor) holding the pipes open, so the timeout wins the race instead of waiting for EOF
  const timeout = new Promise<{ code: number; out: string; err: string }>((resolve) => {
    timer = setTimeout(() => { proc.kill(); resolve({ code: 124, out: "", err: "git timed out" }); }, opts?.timeoutMs ?? GIT_TIMEOUT_MS);
  });
  const cap = opts?.maxOut ?? GIT_MAX_OUT;
  const finished = (async () => {
    // bytes are counted as chunks arrive, so a runaway command is killed instead of buffered
    const [o, e, code] = await Promise.all([readCapped(proc.stdout as ReadableStream<Uint8Array>, cap, () => proc.kill()), readCapped(proc.stderr as ReadableStream<Uint8Array>, cap, () => proc.kill()), proc.exited]);
    if (o.over || e.over) return { code: 125, out: "", err: "git output too large" };
    return { code, out: o.text, err: e.text };
  })().catch((e) => ({ code: 127, out: "", err: e instanceof Error ? e.message : String(e) }));
  try { return await Promise.race([finished, timeout]); } finally { clearTimeout(timer); }
};

/** Reads a stream as text; once more than `cap` bytes arrived it calls `onOver`, stops reading and reports `over`. */
async function readCapped(stream: ReadableStream<Uint8Array>, cap: number, onOver: () => void): Promise<{ text: string; over: boolean }> {
  const reader = stream.getReader(), dec = new TextDecoder();
  let text = "", bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { text: text + dec.decode(), over: false };
    bytes += value.byteLength;
    if (bytes > cap) { onOver(); reader.cancel().catch(() => {}); return { text: "", over: true }; }
    text += dec.decode(value, { stream: true });
  }
}

/** A git command that exited non-zero; `code` is its exit status (or 124/125/127 from `runGit`). */
export class GitError extends Error {
  constructor(message: string, readonly code: number) { super(message); this.name = "GitError"; }
}

/** A failed run as a `GitError`: git's stderr, or "git not found" when git could not be started at all (127). */
const failure = (r: { code: number; err: string }) => new GitError(r.code === 127 ? "git not found" : r.err.trim() || "git failed", r.code);

/** Read-only view of one repository, built on git plumbing. */
export class GitReader {
  constructor(readonly repoPath: string, private run: GitRunner = runGit) {}

  private async git(args: string[], cwd = this.repoPath): Promise<string> {
    const r = await this.run(args, cwd);
    if (r.code !== 0) throw failure(r);
    return r.out;
  }

  /** True when `repoPath` is inside a git work tree. */
  async isRepo(): Promise<boolean> {
    return (await this.probeRepo()).ok;
  }

  /** `rev-parse --is-inside-work-tree`: git failing to run at all (missing binary, timeout) throws instead of reading as "not a repo". */
  private async probeRepo(): Promise<{ ok: boolean }> {
    const r = await this.run(["rev-parse", "--is-inside-work-tree"], this.repoPath);
    if (r.code === 124 || r.code === 125 || r.code === 127) throw failure(r);
    return { ok: r.code === 0 && r.out.trim() === "true" };
  }

  /** Local branches and tags; annotated tags carry the commit they peel to. */
  async refs(): Promise<Ref[]> {
    return parseRefs(await this.git(["for-each-ref", "--format=%(refname)\x1f%(objectname)\x1f%(*objectname)", "refs/heads", "refs/tags"]));
  }

  async worktrees(): Promise<Worktree[]> {
    return parseWorktrees(await this.git(["worktree", "list", "--porcelain"]));
  }

  /** Number of changed or untracked entries in a worktree. */
  async dirty(worktreePath: string): Promise<number> {
    return parseStatusCount(await this.git(["status", "--porcelain=v1"], worktreePath));
  }

  async aheadBehind(branch: string, base: string): Promise<{ ahead: number; behind: number }> {
    return parseAheadBehind(await this.git(["rev-list", "--left-right", "--count", `refs/heads/${branch}...refs/heads/${base}`, "--"]));
  }

  /** Newest `limit` commits (date order) of all branches or one; `truncated` when more existed. */
  async log(opts: { limit: number; branch?: string }): Promise<{ commits: RawCommit[]; truncated: boolean }> {
    const scope = opts.branch ? [`refs/heads/${opts.branch}`] : ["--branches"];
    const all = parseLog(await this.git(["log", "--date-order", "-n", String(opts.limit + 1), `--format=${LOG_FORMAT}`, ...scope, "--"]));
    return { commits: all.slice(0, opts.limit), truncated: all.length > opts.limit };
  }

  /** The commit with body, numstat files and parent summaries; null when `sha` names no commit. */
  async detail(sha: string): Promise<CommitDetail | null> {
    const v = await this.run(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], this.repoPath);
    if (v.code === 1) return null;                       // --verify --quiet: exit 1 means "not a commit"; anything else is git failing
    if (v.code !== 0) throw failure(v);
    const full = v.out.trim();
    const [raw] = parseLog(await this.git(["log", "-n", "1", `--format=${LOG_FORMAT}`, full, "--"]));
    if (!raw) return null;
    const numstat = raw.parents.length
      ? await this.git(["diff", "--numstat", `${full}^1`, full, "--"])
      : await this.git(["diff-tree", "-r", "--root", "--numstat", "--no-commit-id", full]);
    const files = parseNumstat(numstat);
    const totals = files.reduce((t, f) => ({ files: t.files + 1, added: t.added + f.added, deleted: t.deleted + f.deleted }), { files: 0, added: 0, deleted: 0 });
    const parents = await Promise.all(raw.parents.map(async (p) => {
      const [h, subject = ""] = (await this.git(["log", "-n", "1", "--format=%H%x1f%s", p, "--"])).trim().split("\x1f");
      return { sha: h, short: h.slice(0, 7), subject };
    }));
    return { commit: toRepoCommit(raw, tipsOf(await this.refs())), body: raw.body, files, totals, parents };
  }

  /** Refs, live worktrees with their dirty counts, and the fingerprint of both: no log, no ahead/behind. Never throws. */
  async probe(): Promise<RepoProbe | { error: string }> {
    try {
      if (!(await this.probeRepo()).ok) throw new GitError(`not a git repository: ${this.repoPath}`, 128);
      const refs = await this.refs();
      // a prunable worktree whose folder is gone is skipped; one whose status fails counts as clean
      const live = (await this.worktrees()).filter((w) => !w.bare && existsSync(w.path));
      const worktrees = await Promise.all(live.map(async (w): Promise<ProbedWorktree> => ({ ...w, dirty: await this.dirty(w.path).catch(() => 0) })));
      return { refs, worktrees, fingerprint: fingerprintOf(refs, worktrees) };
    } catch (e) {
      return { error: messageOf(e) };
    }
  }

  /** The snapshot for a probe: ahead/behind (`AHEAD_BEHIND_POOL` branches at a time) and the log. Never throws. */
  async build(probe: RepoProbe, opts: { limit?: number; branch?: string } = {}): Promise<RepoSnapshot> {
    const limit = opts.limit ?? 100;
    try {
      const { refs, worktrees } = probe;
      const defaultBranch = GitReader.defaultBranch(refs);
      const branches = await mapPool(refs.filter((r) => r.kind === "branch"), AHEAD_BEHIND_POOL, async (r) => {
        const b: RepoBranch = { name: r.name, sha: r.sha, isDefault: r.name === defaultBranch, ahead: 0, behind: 0 };
        const w = worktrees.find((x) => !x.detached && x.branch === r.name);
        if (w) b.worktree = { path: w.path, dirty: w.dirty };
        if (!b.isDefault) Object.assign(b, await this.aheadBehind(r.name, defaultBranch));
        return b;
      });
      const { commits, truncated } = await this.log({ limit, branch: opts.branch });
      const tips = tipsOf(refs);
      return { repoPath: this.repoPath, defaultBranch, branches, commits: commits.map((c) => toRepoCommit(c, tips)), limit, truncated, fingerprint: probe.fingerprint };
    } catch (e) {
      return errorSnapshot(this.repoPath, limit, messageOf(e));
    }
  }

  /** Everything the Repo tab shows: `probe`, then `build`. Never throws; a failure becomes `error` on an empty snapshot. */
  async snapshot(opts: { limit?: number; branch?: string } = {}): Promise<RepoSnapshot> {
    const probe = await this.probe();
    return "error" in probe ? errorSnapshot(this.repoPath, opts.limit ?? 100, probe.error) : this.build(probe, opts);
  }

  /** "main" if present, else "master", else the first branch, else "main". */
  static defaultBranch(refs: Ref[]): string {
    const names = refs.filter((r) => r.kind === "branch").map((r) => r.name);
    return names.includes("main") ? "main" : names.includes("master") ? "master" : names[0] ?? "main";
  }
}

/** An empty snapshot carrying `message` as its error: what the Repo tab shows when the repository cannot be read. */
export function errorSnapshot(repoPath: string, limit: number, message: string): RepoSnapshot {
  return { repoPath, defaultBranch: "main", branches: [], commits: [], limit, truncated: false, fingerprint: "", error: message };
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `Promise.all(items.map(fn))` with at most `size` calls running at once; after a rejection no further call starts. */
async function mapPool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i]); } catch (e) { next = items.length; throw e; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

/** Branch and tag names by the commit they point at. */
function tipsOf(refs: Ref[]): Map<string, { branches: string[]; tags: string[] }> {
  const tips = new Map<string, { branches: string[]; tags: string[] }>();
  for (const r of refs) {
    const t = tips.get(r.sha) ?? { branches: [], tags: [] };
    (r.kind === "branch" ? t.branches : t.tags).push(r.name);
    tips.set(r.sha, t);
  }
  return tips;
}

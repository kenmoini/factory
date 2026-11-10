import { existsSync, realpathSync } from "node:fs";
import { readRepoConfig, writeRepoConfig, type RepoConfig } from "./config";
import { defaultBranch, git } from "./git";

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function validateSlug(slug: string): string | null {
  if (SLUG_RE.test(slug)) return null;
  return `invalid slug "${slug}": must match ${SLUG_RE} (lowercase letters, digits and hyphens; start with a letter or digit; max 63 chars)`;
}

export function worktreePath(repoDir: string, slug: string): string {
  return `${repoDir}/.factory/worktrees/${slug}`;
}

export class ForeignBranchError extends Error {}

async function branchExists(repoDir: string, slug: string): Promise<boolean> {
  return (await git(repoDir, "rev-parse", "--verify", "--quiet", `refs/heads/${slug}`)).code === 0;
}

async function worktreeOnBranch(repoDir: string, path: string, slug: string): Promise<boolean> {
  const { out } = await git(repoDir, "worktree", "list", "--porcelain");
  const real = realpathSync(path); // git reports resolved paths (e.g. /private/var on macOS)
  for (const block of out.split(/\n\n+/)) {
    const lines = block.split("\n");
    if ((lines.includes(`worktree ${path}`) || lines.includes(`worktree ${real}`)) && lines.includes(`branch refs/heads/${slug}`)) return true;
  }
  return false;
}

export async function ensureWorktree(
  repoDir: string,
  slug: string,
  opts: { adopt?: boolean; baseRef?: string } = {},
): Promise<{ path: string; branch: string; created: boolean; branchCreated: boolean }> {
  const reason = validateSlug(slug);
  if (reason) throw new Error(reason);
  const path = worktreePath(repoDir, slug);
  const cfg: RepoConfig = readRepoConfig(repoDir) ?? { workstreams: {} };
  const existing = cfg.workstreams?.[slug];
  const hasBranch = await branchExists(repoDir, slug);
  if (hasBranch && !existing && !opts.adopt) {
    throw new ForeignBranchError(`branch "${slug}" exists but is not a factory workstream; pass --adopt to use it`);
  }

  let created = false;
  let branchCreated = false;
  if (existsSync(path) && (await worktreeOnBranch(repoDir, path, slug))) {
    // already in place
  } else {
    await git(repoDir, "worktree", "prune");
    const args = hasBranch
      ? ["worktree", "add", path, slug]
      : ["worktree", "add", "-b", slug, path, opts.baseRef ?? (await defaultBranch(repoDir))];
    const r = await git(repoDir, ...args);
    if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.err}`);
    created = true;
    branchCreated = !hasBranch;
  }

  cfg.workstreams = cfg.workstreams ?? {};
  cfg.workstreams[slug] = { noteId: existing?.noteId ?? "", branch: slug, worktree: `.factory/worktrees/${slug}` };
  writeRepoConfig(repoDir, cfg);
  return { path, branch: slug, created, branchCreated };
}

export async function removeWorktree(
  repoDir: string,
  slug: string,
  opts: { deleteBranch?: boolean } = {},
): Promise<{ removed: boolean }> {
  const reason = validateSlug(slug);
  if (reason) throw new Error(reason);
  const path = worktreePath(repoDir, slug);
  const existed = existsSync(path);
  const r = await git(repoDir, "worktree", "remove", "--force", path);
  await git(repoDir, "worktree", "prune");
  if (opts.deleteBranch) {
    await git(repoDir, "branch", "-D", slug);
    const cfg = readRepoConfig(repoDir);
    if (cfg?.workstreams?.[slug]) {
      delete cfg.workstreams[slug];
      writeRepoConfig(repoDir, cfg);
    }
  }
  return { removed: existed && r.code === 0 };
}

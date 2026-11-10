export async function git(repoDir: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  try {
    const p = Bun.spawn(["git", "-C", repoDir, ...args], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, out: out.trim(), err: err.trim() };
  } catch (e) {
    return { code: 127, out: "", err: String(e) };
  }
}

export async function defaultBranch(repoDir: string): Promise<string> {
  for (const b of ["main", "master"]) {
    if ((await git(repoDir, "rev-parse", "--verify", "--quiet", `refs/heads/${b}`)).code === 0) return b;
  }
  return (await git(repoDir, "rev-parse", "--abbrev-ref", "HEAD")).out;
}

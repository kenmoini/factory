import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PORT, readGlobalConfig, readRepoConfig } from "./config";

export type Preflight = {
  config: { global: boolean; repo: boolean; dir: string };
  trilium: { ok: boolean; url?: string; version?: string; mcpEndpoint?: boolean; mcpRegistered?: boolean; error?: string };
  dashboard: { running: boolean; port: number };
  git: { isRepo: boolean; root?: string; branch?: string; dirty?: boolean; hasCommits?: boolean };
  factory: { configured: boolean; projectNoteId?: string; activeWorkstream?: string; worktree?: string };
  graphify: { installed: boolean; outPresent: boolean; ageMinutes?: number; gitHooks: boolean };
  tools: { bun: boolean; uv: boolean; node: boolean; superpowers: boolean };
};

type Exec = (cmd: string[]) => Promise<{ code: number; out: string }>;

async function defaultExec(cmd: string[]): Promise<{ code: number; out: string }> {
  try {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, out: (o + e).trim() };
  } catch {
    return { code: 127, out: "" };
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const t = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function preflight(opts: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  exec?: Exec;
}): Promise<Preflight> {
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const f = opts.fetchImpl ?? fetch;
  const rawExec = opts.exec ?? defaultExec;
  const exec: Exec = (cmd) => withTimeout(rawExec(cmd).catch(() => ({ code: 127, out: "" })), timeoutMs);
  const get = (url: string, headers?: Record<string, string>) =>
    withTimeout(Promise.resolve().then(() => f(url, { headers, signal: AbortSignal.timeout(timeoutMs) })), timeoutMs);
  const settle = async <T>(p: Promise<T>): Promise<T | undefined> => (await Promise.allSettled([p]))[0].status === "fulfilled" ? await p : undefined;

  const has = async (name: string) => (await settle(exec(["sh", "-c", `command -v ${name}`])))?.code === 0;
  const g = readGlobalConfig(env);
  const dir = `${env.FACTORY_CONFIG_DIR ?? `${env.HOME}/.config/claude-factory`}`;
  const port = g?.dashboardPort ?? DEFAULT_PORT;
  const cwd = opts.cwd;

  const graphifyInstalled = has("graphify");
  const trilium = triliumProbe();
  const dashboard = dashboardProbe();
  const tools = toolsProbe();

  // git: root is needed for graphify files / repo config
  const gitRun = async (args: string[]) => settle(exec(["git", "-C", cwd, ...args]));
  const [top, branch, status, head] = await Promise.all([
    gitRun(["rev-parse", "--show-toplevel"]),
    gitRun(["rev-parse", "--abbrev-ref", "HEAD"]),
    gitRun(["status", "--porcelain"]),
    gitRun(["rev-parse", "HEAD"]),
  ]);
  const isRepo = top?.code === 0 && top.out !== "";
  const root = isRepo ? top!.out : undefined;
  const base = root ?? cwd;
  const git: Preflight["git"] = isRepo
    ? {
        isRepo: true,
        root,
        branch: branch?.code === 0 ? branch.out : undefined,
        dirty: status?.code === 0 ? status.out !== "" : undefined,
        hasCommits: head?.code === 0,
      }
    : { isRepo: false };

  const repoCfg = readRepoConfig(base);
  const factory: Preflight["factory"] = {
    configured: repoCfg !== null,
    projectNoteId: repoCfg?.projectNoteId,
    activeWorkstream: repoCfg?.activeWorkstream,
    worktree: repoCfg?.activeWorkstream ? `.factory/worktrees/${repoCfg.activeWorkstream}` : undefined,
  };

  function triliumProbe(): Promise<Preflight["trilium"]> { return (async (): Promise<Preflight["trilium"]> => {
    if (!g || !g.triliumUrl) return { ok: false, error: "no config" };
    const url = g.triliumUrl.replace(/\/+$/, "");
    const out: Preflight["trilium"] = { ok: false, url };
    const mcpP = get(`${url}/mcp`, { Authorization: `Bearer ${g.etapiToken}` });
    const regP = exec(["claude", "mcp", "get", "trilium"]);
    const done = Promise.allSettled([mcpP, regP]);
    try {
      const res = await get(`${url}/etapi/app-info`, { Authorization: g.etapiToken });
      if (!res.ok) {
        out.error = `HTTP ${res.status}`;
        await done;
        return out;
      }
      out.ok = true;
      try {
        out.version = ((await withTimeout(res.json(), timeoutMs)) as { appVersion?: string }).appVersion;
      } catch {}
    } catch (e) {
      out.error = msg(e);
      await done;
      return out;
    }
    const [mcp, reg] = await done;
    out.mcpEndpoint = mcp.status === "fulfilled" && mcp.value.status !== 404;
    out.mcpRegistered = reg.status === "fulfilled" && reg.value.code === 0;
    return out;
  })(); }

  function dashboardProbe() { return (async () => {
    try {
      const res = await get(`http://127.0.0.1:${port}/api/health`);
      return { running: res.ok, port };
    } catch {
      return { running: false, port };
    }
  })(); }

  const graphify = (async (): Promise<Preflight["graphify"]> => {
    const graph = join(base, "graphify-out", "graph.json");
    let outPresent = false;
    let ageMinutes: number | undefined;
    try {
      ageMinutes = Math.max(0, Math.round((Date.now() - statSync(graph).mtimeMs) / 60000));
      outPresent = true;
    } catch {}
    let gitHooks = false;
    try {
      const hook = join(base, ".git", "hooks", "post-commit");
      gitHooks = existsSync(hook) && readFileSync(hook, "utf8").includes("graphify");
    } catch {}
    return { installed: await graphifyInstalled, outPresent, ageMinutes, gitHooks };
  })();

  function toolsProbe(): Promise<Preflight["tools"]> { return (async (): Promise<Preflight["tools"]> => {
    const [bun, uv, node] = await Promise.all([has("bun"), has("uv"), has("node")]);
    let superpowers = false;
    try {
      const p = `${env.HOME}/.claude/plugins/installed_plugins.json`;
      superpowers = existsSync(p) && readFileSync(p, "utf8").includes('"superpowers@');
    } catch {}
    return { bun, uv, node, superpowers };
  })(); }

  const [t, d, gr, tl] = await Promise.all([trilium, dashboard, graphify, tools]);
  return {
    config: { global: g !== null, repo: repoCfg !== null, dir },
    trilium: t,
    dashboard: d,
    git,
    factory,
    graphify: gr,
    tools: tl,
  };
}

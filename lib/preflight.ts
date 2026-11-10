import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PORT, globalConfigDir, hasLegacyTriliumKeys, readGlobalConfig, readRepoConfig } from "./config";
import { readTriliumMcp, tlsRejectUnauthorized, type TriliumMcp } from "./trilium-config";

export type Preflight = {
  /** global: the global config file (dashboardPort) exists; legacyTriliumKeys: it still holds triliumUrl/etapiToken. */
  config: { global: boolean; repo: boolean; dir: string; legacyTriliumKeys: boolean };
  /** From the `trilium` MCP server entry (project .mcp.json, else user scope, else env); never the token. */
  trilium: {
    configured: boolean;
    placeholder: boolean;
    source?: TriliumMcp["source"];
    ok: boolean;
    url?: string;
    version?: string;
    mcpEndpoint?: boolean;
    mcpRegistered?: boolean;
    error?: string;
  };
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
  const tls = { rejectUnauthorized: tlsRejectUnauthorized(env) }; // Bun fetch option: off unless FACTORY_TLS_VERIFY=1
  const get = (url: string, headers?: Record<string, string>) =>
    withTimeout(Promise.resolve().then(() => f(url, { headers, signal: AbortSignal.timeout(timeoutMs), tls })), timeoutMs);
  const settle = async <T>(p: Promise<T>): Promise<T | undefined> => (await Promise.allSettled([p]))[0].status === "fulfilled" ? await p : undefined;

  const has = async (name: string) => (await settle(exec(["sh", "-c", `command -v ${name}`])))?.code === 0;
  const safe = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };
  const g = safe(() => readGlobalConfig(env), null);
  const legacyTriliumKeys = hasLegacyTriliumKeys(g);
  const dir = safe(() => globalConfigDir(env), "");
  const port = g?.dashboardPort ?? DEFAULT_PORT;
  const cwd = opts.cwd;

  const graphifyInstalled = has("graphify");
  // git: root is needed for graphify files / repo config / .mcp.json
  const gitRun = async (args: string[]) => settle(exec(["git", "-C", cwd, ...args]));
  const topP = gitRun(["rev-parse", "--show-toplevel"]);
  const trilium = triliumProbe();
  const dashboard = dashboardProbe();
  const tools = toolsProbe();

  const [top, branch, status, head] = await Promise.all([
    topP,
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

  const repoCfg = safe(() => readRepoConfig(base), null);
  const factory: Preflight["factory"] = {
    configured: repoCfg !== null,
    projectNoteId: repoCfg?.projectNoteId,
    activeWorkstream: repoCfg?.activeWorkstream,
    worktree: repoCfg?.activeWorkstream ? `.factory/worktrees/${repoCfg.activeWorkstream}` : undefined,
  };

  /** Project `.mcp.json` in cwd; else at the git root (setup writes `<repoPath>/.mcp.json`); else user scope / env. */
  async function triliumEntry(): Promise<TriliumMcp | null> {
    const here = safe(() => readTriliumMcp(cwd, env), null);
    if (here?.source === "project" || here?.source === "env") return here;
    const t = await topP;
    const gitRoot = t?.code === 0 && t.out !== "" ? t.out : undefined;
    const atRoot = gitRoot && gitRoot !== cwd ? safe(() => readTriliumMcp(gitRoot, env), null) : null;
    return atRoot?.source === "project" ? atRoot : here;
  }

  function triliumProbe(): Promise<Preflight["trilium"]> { return (async (): Promise<Preflight["trilium"]> => {
    const t = await triliumEntry();
    if (!t) return { configured: false, placeholder: false, ok: false, error: "not configured" };
    const url = t.baseUrl;
    const out: Preflight["trilium"] = { configured: true, placeholder: t.placeholder, source: t.source, ok: false, url };
    if (t.placeholder) return { ...out, error: "token placeholder" }; // never send the placeholder to Trilium
    const mcpP = get(t.mcpUrl, { Authorization: `Bearer ${t.token}` });
    const regP = exec(["claude", "mcp", "get", "trilium"]);
    const done = Promise.allSettled([mcpP, regP]);
    try {
      const res = await get(`${url}/etapi/app-info`, { Authorization: t.token });
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
    config: { global: g !== null, repo: repoCfg !== null, dir, legacyTriliumKeys },
    trilium: t,
    dashboard: d,
    git,
    factory,
    graphify: gr,
    tools: tl,
  };
}

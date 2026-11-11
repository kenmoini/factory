// factory-dashboard daemon lifecycle: start | stop | status | open | restart
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config";

const env = process.env;
const dashboardDir = join(import.meta.dir, "..");
const serverPath = join(import.meta.dir, "server.ts");

function parseArgs(argv: string[]): { cmd: string; port?: number; open: boolean } {
  const cmd = argv[0] ?? "status";
  let port: number | undefined;
  let open = false;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--port") { const n = Number(argv[++i]); if (Number.isInteger(n) && n > 0) port = n; }
    else if (argv[i] === "--open") open = true;
  }
  return { cmd, port, open };
}

const args = parseArgs(process.argv.slice(2));
// needs no Trilium config: the server reads each repo's from its .mcp.json
const config = loadConfig(env);
const { configDir } = config;
const pidFile = join(configDir, "dashboard.pid");
const logFile = join(configDir, "dashboard.log");
const port = args.port ?? config.port;
const url = `http://127.0.0.1:${port}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const print = (o: unknown) => console.log(JSON.stringify(o));

function readPid(): number | undefined {
  try {
    const n = Number(readFileSync(pidFile, "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch { return undefined; }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
type Probe = { ok: false } | { ok: true; pid: number | null };
/**
 * Asks the port's listener for /api/health: `ok` once anything answers HTTP, `pid` the process the answer names (a
 * factory server always names itself), null when it names none.
 */
async function probe(): Promise<Probe> {
  let text: string;
  try {
    text = await (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) })).text();
  } catch { return { ok: false }; }
  let pid: unknown;
  try { pid = JSON.parse(text)?.pid; } catch { /* not JSON: names no process */ }
  return { ok: true, pid: typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null };
}
/** The listener is a factory dashboard server, whichever pid the pidfile names. */
const ours = (p: Probe): p is { ok: true; pid: number } => p.ok && p.pid !== null && isOurServer(p.pid);
/** Points the pidfile at `pid` when it names another process; true when it was rewritten. */
function claimPid(pid: number): boolean {
  if (readPid() === pid) return false;
  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(pidFile, String(pid));
    return true;
  } catch (e) {
    log(`cannot write pidfile: ${(e as Error).message}`);
    return false;
  }
}
function tail(n = 20): string[] {
  try { return readFileSync(logFile, "utf8").split("\n").filter(Boolean).slice(-n); } catch { return []; }
}
function openUrl(): void {
  const bin = process.platform === "darwin" ? "open" : "xdg-open";
  try { Bun.spawn([bin, url], { stdio: ["ignore", "ignore", "ignore"] }).unref(); } catch { /* no browser */ }
}

/** Reports who listens on the port, and repairs the pidfile when it is our server the pidfile does not name. */
async function status(): Promise<void> {
  const found = await probe();
  if (ours(found)) {
    print({ running: true, port, pid: found.pid, url, ...(claimPid(found.pid) ? { repaired: true } : {}) });
    return;
  }
  if (found.ok) { print({ running: false, port, foreign: true }); return; }
  const pid = readPid();
  if (pid !== undefined && !alive(pid)) rmSync(pidFile, { force: true });
  print({ running: false, port });
}

function isOurServer(pid: number): boolean {
  try {
    const r = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    return r.exitCode === 0 && r.stdout.toString().includes("dashboard/src/server.ts");
  } catch { return false; }
}

function log(line: string): void {
  try {
    mkdirSync(configDir, { recursive: true });
    appendFileSync(logFile, `${new Date().toISOString()} factory-dashboard daemon: ${line}\n`);
  } catch { /* no log, no fuss */ }
}

/**
 * The repo `factory-dashboard start` runs from is registered right away, so its board shows before the first hook
 * event. Failures are logged, never fatal: the next event registers the repo anyway.
 */
async function registerCwd(): Promise<void> {
  const cwd = process.cwd();
  if (!existsSync(join(cwd, ".factory", "config.json"))) return;
  // the calling Claude session uses the server while its process lives (see sessions.ts)
  const body: { path: string; session?: string; pid?: number } = { path: cwd };
  if (env.CLAUDE_CODE_SESSION_ID) body.session = env.CLAUDE_CODE_SESSION_ID;
  if (/^[0-9]+$/.test(env.CLAUDE_PID ?? "")) body.pid = Number(env.CLAUDE_PID);
  try {
    const r = await fetch(`${url}/api/repos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) log(`registering ${cwd} returned ${r.status}`);
  } catch (e) {
    log(`registering ${cwd} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** A plugin install has no dashboard/node_modules: install the locked deps once, output to the log. */
function ensureDeps(): boolean {
  if (existsSync(join(dashboardDir, "node_modules"))) return true;
  mkdirSync(configDir, { recursive: true });
  const fd = openSync(logFile, "a");
  try {
    const r = Bun.spawnSync([process.execPath, "install", "--frozen-lockfile"], { cwd: dashboardDir, stdin: "ignore", stdout: fd, stderr: fd });
    return r.exitCode === 0;
  } catch {
    return false;
  } finally { closeSync(fd); }
}

async function terminate(pid: number): Promise<void> {
  try { process.kill(pid, "SIGTERM"); } catch { /* raced */ }
  const deadline = Date.now() + 5000;
  while (alive(pid) && Date.now() < deadline) await sleep(100);
  if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
}

async function start(): Promise<number> {
  const found = await probe();
  if (ours(found)) {
    await registerCwd();
    print({ running: true, port, pid: found.pid, url, ...(claimPid(found.pid) ? { adopted: true } : {}) });
    if (args.open) openUrl();
    return 0;
  }
  if (found.ok) {
    print({ running: false, error: `port ${port} is in use by another program` });
    return 1;
  }
  const existing = readPid();
  let replaced: number | undefined;
  if (existing !== undefined && alive(existing)) {
    if (isOurServer(existing)) {
      // it may still be starting: wait for it to answer before replacing it
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const p = await probe();
        if (p.ok && p.pid === existing) {
          await registerCwd();
          print({ running: true, port, pid: existing, url });
          if (args.open) openUrl();
          return 0;
        }
        await sleep(200);
      }
      await terminate(existing);
      replaced = existing;
    } else {
      rmSync(pidFile, { force: true }); // pid reused by an unrelated process
    }
  }
  if (!ensureDeps()) {
    print({ running: false, error: "bun install failed", log: logFile });
    return 1;
  }
  mkdirSync(configDir, { recursive: true });
  const logFd = openSync(logFile, "a");
  // Trilium often runs on a self-signed certificate: TLS verification is off unless FACTORY_TLS_VERIFY=1 (the clients
  // also pass Bun's per-request `tls` option; this covers any other request the server makes). With verification on,
  // an inherited NODE_TLS_REJECT_UNAUTHORIZED (e.g. "0" from Claude Code's settings env) is dropped.
  const serverEnv: Record<string, string | undefined> = { ...env, FACTORY_DASHBOARD_PORT: String(port) };
  if (config.tlsVerify) delete serverEnv.NODE_TLS_REJECT_UNAUTHORIZED;
  else serverEnv.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([process.execPath, serverPath], {
      cwd: dashboardDir,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: serverEnv,
    });
  } finally { closeSync(logFd); }
  proc.unref();
  try {
    writeFileSync(pidFile, String(proc.pid));
  } catch (e) {
    try { process.kill(proc.pid, "SIGKILL"); } catch { /* gone */ }
    print({ running: false, error: `cannot write pidfile: ${(e as Error).message}`, log: logFile });
    return 1;
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) break;
    const p = await probe();
    if (p.ok && p.pid === proc.pid) { // only our child: another listener may share the port
      await registerCwd();
      print({ running: true, port, pid: proc.pid, url, ...(replaced !== undefined ? { replaced } : {}) });
      if (args.open) openUrl();
      return 0;
    }
    await sleep(200);
  }
  const wasAlive = proc.exitCode === null && alive(proc.pid);
  if (wasAlive) { try { process.kill(proc.pid, "SIGKILL"); } catch { /* gone */ } }
  rmSync(pidFile, { force: true });
  print({
    running: false,
    error: wasAlive ? "dashboard did not become healthy within 10s" : "dashboard exited during startup",
    log: logFile,
    tail: tail(),
  });
  return 1;
}

/**
 * Ends every factory server on the port: the one that answers, the pidfile's when it is another of ours (the pre-probe
 * daemon could co-bind a duplicate and name it), then whatever of ours still answers, for at most 5 more rounds.
 */
async function stopAll(first: number): Promise<number> {
  const stopped: number[] = [];
  const end = async (pid: number) => { await terminate(pid); stopped.push(pid); };
  await end(first);
  const named = readPid();
  if (named !== undefined && named !== first && alive(named) && isOurServer(named)) await end(named);
  for (let round = 0; ; round++) {
    const found = await probe();
    if (!ours(found)) break;
    if (round === 5) {
      print({ running: true, port, pid: found.pid, error: "could not stop" });
      return 1;
    }
    await end(found.pid);
  }
  rmSync(pidFile, { force: true });
  print({ running: false, stopped: first, ...(stopped.length > 1 ? { alsoStopped: stopped.slice(1) } : {}) });
  return 0;
}

async function stop(): Promise<number> {
  const found = await probe();
  if (ours(found)) return stopAll(found.pid);
  const pid = readPid();
  if (pid === undefined || !alive(pid)) {
    rmSync(pidFile, { force: true });
    print({ running: false });
    return 0;
  }
  if (!isOurServer(pid)) {
    rmSync(pidFile, { force: true });
    print({ running: false, stale: true });
    return 0;
  }
  await terminate(pid);
  rmSync(pidFile, { force: true });
  print({ running: false, stopped: pid });
  return 0;
}

async function main(): Promise<number> {
  switch (args.cmd) {
    case "start": return start();
    case "stop": return stop();
    case "status": await status(); return 0;
    case "open": openUrl(); print({ url }); return 0;
    case "restart": {
      const stopped = await stop();
      return stopped !== 0 ? stopped : start(); // a server that would not stop must not be adopted as the restart
    }
    default:
      console.error("usage: factory-dashboard start [--port N] [--open] | stop | status | open | restart");
      return 2;
  }
}

process.exit(await main());

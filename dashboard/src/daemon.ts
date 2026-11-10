// factory-dashboard daemon lifecycle: start | stop | status | open | restart
import { closeSync, openSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config";

const env = process.env;
const dashboardDir = join(import.meta.dir, "..");
const serverPath = join(import.meta.dir, "server.ts");

function resolveConfig(): { configDir: string; filePort?: number } {
  try {
    const c = loadConfig(env);
    return { configDir: c.configDir, filePort: c.port };
  } catch {
    const configDir = env.FACTORY_CONFIG_DIR ?? `${env.HOME ?? ""}/.config/claude-factory`;
    let filePort: number | undefined;
    try {
      const n = Number(JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"))?.dashboardPort);
      if (Number.isFinite(n) && n > 0) filePort = n;
    } catch { /* no config file */ }
    return { configDir, filePort };
  }
}

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
const { configDir, filePort } = resolveConfig();
const pidFile = join(configDir, "dashboard.pid");
const logFile = join(configDir, "dashboard.log");
const envPort = Number(env.FACTORY_DASHBOARD_PORT);
const port = args.port ?? (Number.isInteger(envPort) && envPort > 0 ? envPort : filePort ?? 7777);
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
async function healthy(): Promise<boolean> {
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
    return r.status === 200;
  } catch { return false; }
}
function tail(n = 20): string[] {
  try { return readFileSync(logFile, "utf8").split("\n").filter(Boolean).slice(-n); } catch { return []; }
}
function openUrl(): void {
  const bin = process.platform === "darwin" ? "open" : "xdg-open";
  try { Bun.spawn([bin, url], { stdio: ["ignore", "ignore", "ignore"] }).unref(); } catch { /* no browser */ }
}

async function status(): Promise<{ running: boolean; pid?: number }> {
  const pid = readPid();
  const running = pid !== undefined && alive(pid) && (await healthy());
  const out: Record<string, unknown> = { running, port };
  if (running) { out.pid = pid; out.url = url; }
  print(out);
  return { running, pid };
}

async function start(): Promise<number> {
  const existing = readPid();
  if (existing !== undefined && alive(existing) && (await healthy())) {
    print({ running: true, port, pid: existing, url });
    if (args.open) openUrl();
    return 0;
  }
  mkdirSync(configDir, { recursive: true });
  const logFd = openSync(logFile, "a");
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([process.execPath, serverPath], {
      cwd: dashboardDir,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...env, FACTORY_DASHBOARD_PORT: String(port) },
    });
  } finally { closeSync(logFd); }
  proc.unref();
  writeFileSync(pidFile, String(proc.pid));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await healthy()) {
      print({ running: true, port, pid: proc.pid, url });
      if (args.open) openUrl();
      return 0;
    }
    if (!alive(proc.pid)) break;
    await sleep(200);
  }
  const wasAlive = alive(proc.pid);
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

async function stop(): Promise<number> {
  const pid = readPid();
  if (pid === undefined || !alive(pid)) {
    rmSync(pidFile, { force: true });
    print({ running: false });
    return 0;
  }
  try { process.kill(pid, "SIGTERM"); } catch { /* raced */ }
  const deadline = Date.now() + 5000;
  while (alive(pid) && Date.now() < deadline) await sleep(100);
  if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
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
      await stop();
      return start();
    }
    default:
      console.error("usage: factory-dashboard start [--port N] [--open] | stop | status | open | restart");
      return 2;
  }
}

process.exit(await main());

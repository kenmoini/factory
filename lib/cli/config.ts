import { existsSync, readFileSync } from "node:fs";
import { getPath, globalConfigPath, readGlobalConfig, readRepoConfig, repoConfigPath, setPath, writeGlobalConfig, writeRepoConfig, type GlobalConfig, type RepoConfig } from "../config";

const USAGE = "usage: factory-config get <key> [--repo <dir>] | set <key> <value> [--repo <dir>] | path [--repo <dir>]";
function usage(): never {
  console.error(USAGE);
  process.exit(2);
}

const argv = process.argv.slice(2);
let repo: string | undefined;
const pos: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--repo") {
    repo = argv[++i];
    if (!repo) usage(); // never fall back to the global config silently
  } else pos.push(argv[i]);
}
const [cmd, key, value] = pos;

const path = repo ? repoConfigPath(repo) : globalConfigPath();
const load = (): Record<string, unknown> =>
  ((repo ? readRepoConfig(repo) : readGlobalConfig()) as Record<string, unknown> | null) ?? {};

/** An existing file that does not parse to a JSON object is never overwritten. */
function invalidJson(file: string): boolean {
  if (!existsSync(file)) return false;
  try {
    const v: unknown = JSON.parse(readFileSync(file, "utf8"));
    return v === null || typeof v !== "object" || Array.isArray(v);
  } catch {
    return true;
  }
}

if (cmd === "path") {
  console.log(path);
} else if (cmd === "get" && key) {
  const v = getPath(load(), key);
  if (v === undefined) {
    console.error(`missing: ${key}`);
    process.exit(1);
  }
  console.log(typeof v === "object" ? JSON.stringify(v) : String(v));
} else if (cmd === "set" && key && value !== undefined) {
  if (invalidJson(path)) {
    console.log(JSON.stringify({ error: "config.json is not valid JSON; fix or delete it" }));
    process.exit(1);
  }
  const cfg = load();
  if (repo && !("workstreams" in cfg)) cfg.workstreams = {};
  setPath(cfg, key, key === "dashboardPort" ? Number(value) : value);
  console.log(repo ? writeRepoConfig(repo, cfg as unknown as RepoConfig) : writeGlobalConfig(cfg as unknown as GlobalConfig));
} else {
  usage();
}

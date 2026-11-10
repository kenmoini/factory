import { getPath, globalConfigPath, readGlobalConfig, readRepoConfig, repoConfigPath, setPath, writeGlobalConfig, writeRepoConfig, type GlobalConfig, type RepoConfig } from "../config";

const argv = process.argv.slice(2);
let repo: string | undefined;
const pos: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--repo") repo = argv[++i];
  else pos.push(argv[i]);
}
const [cmd, key, value] = pos;

const path = repo ? repoConfigPath(repo) : globalConfigPath();
const load = (): Record<string, unknown> =>
  ((repo ? readRepoConfig(repo) : readGlobalConfig()) as Record<string, unknown> | null) ?? {};

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
  const cfg = load();
  if (repo && !("workstreams" in cfg)) cfg.workstreams = {};
  setPath(cfg, key, key === "dashboardPort" ? Number(value) : value);
  console.log(repo ? writeRepoConfig(repo, cfg as unknown as RepoConfig) : writeGlobalConfig(cfg as unknown as GlobalConfig));
} else {
  console.error("usage: factory-config get <key> [--repo <dir>] | set <key> <value> [--repo <dir>] | path [--repo <dir>]");
  process.exit(2);
}

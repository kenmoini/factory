import { ensureEnv, ensureMcpServer, type SettingsResult } from "../settings";

const USAGE = "usage: factory-settings env <file> KEY=VALUE [KEY=VALUE…] | mcp <file> <name> <url>";
function usage(): never {
  console.error(USAGE);
  process.exit(2);
}

const [cmd, file, ...rest] = process.argv.slice(2);
let run: () => SettingsResult;
if (cmd === "env" && file && rest.length > 0) {
  const pairs: Record<string, string> = {};
  for (const a of rest) {
    const i = a.indexOf("=");
    if (i < 1) usage();
    pairs[a.slice(0, i)] = a.slice(i + 1);
  }
  run = () => ensureEnv(file, pairs);
} else if (cmd === "mcp" && file && rest.length === 2 && rest.every((a) => a.trim() !== "")) {
  run = () => ensureMcpServer(file, rest[0], rest[1]);
} else usage();

let result: SettingsResult;
try {
  result = run();
} catch (e) {
  result = "invalid"; // a failed write; the target is untouched
  // why, for the reader of `invalid`: the OS error (EACCES, ENOSPC, ENOTDIR…), never file content
  console.error(`factory-settings: ${e instanceof Error ? e.message : String(e)}`);
}
console.log(result);
process.exit(result === "written" || result === "unchanged" ? 0 : 1);

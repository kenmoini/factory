import { readFileSync } from "node:fs";
import { mergeBranch } from "../merge";

// Exit codes: 0 merged / up-to-date, 2 conflict, 3 dirty, 1 error (usage errors included: 2 means conflict).
const USAGE = "usage: factory-merge <repo> <branch> (<message> | --message-file <path>) [--into <branch>]";
function fail(message: string): never {
  console.log(JSON.stringify({ result: "error", message }));
  process.exit(1);
}

const argv = process.argv.slice(2);
let into: string | undefined;
let messageFile: string | undefined;
let usage = false;
const pos: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--into" || argv[i] === "--message-file") {
    const v = argv[++i];
    if (!v) usage = true;
    else if (argv[i - 1] === "--into") into = v;
    else messageFile = v;
  } else pos.push(argv[i]);
}
const [repoDir, branch] = pos;
// --message-file wins over a positional message; without it the positional is required.
if (usage || !repoDir || !branch || pos.length > 3 || (messageFile === undefined && pos.length !== 3)) fail(USAGE);

let message = pos[2];
if (messageFile !== undefined) {
  try {
    message = readFileSync(messageFile, "utf8").trimEnd();
  } catch (e) {
    fail(`cannot read message file ${messageFile}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
if (!message?.trim()) fail("empty merge message");

const r = await mergeBranch({ repoDir, branch, message, into });
console.log(JSON.stringify(r));
process.exit({ merged: 0, "up-to-date": 0, conflict: 2, dirty: 3, error: 1 }[r.result]);

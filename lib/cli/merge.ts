import { mergeBranch } from "../merge";

const argv = process.argv.slice(2);
let into: string | undefined;
const pos: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--into") into = argv[++i];
  else pos.push(argv[i]);
}
const [repoDir, branch, message] = pos;
if (!repoDir || !branch || !message || pos.length !== 3 || (argv.includes("--into") && !into)) {
  console.error('usage: factory-merge <repo> <branch> "<message>" [--into <branch>]');
  process.exit(2);
}
const r = await mergeBranch({ repoDir, branch, message, into });
console.log(JSON.stringify(r));
process.exit({ merged: 0, "up-to-date": 0, conflict: 2, dirty: 3, error: 1 }[r.result]);

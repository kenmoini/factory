import { buildReviewPackage } from "../review-package";

const argv = process.argv.slice(2);
let out: string | undefined;
let context: number | undefined;
const pos: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--out") out = argv[++i];
  else if (argv[i] === "--context") context = Number(argv[++i]);
  else pos.push(argv[i]);
}
const [worktree, base, head] = pos;

if (!worktree || !base || !head || !out || (context !== undefined && !Number.isInteger(context))) {
  console.error("usage: factory-review-package <worktree> <base> <head> --out <file> [--context N]");
  process.exit(2);
}

try {
  console.log(JSON.stringify(await buildReviewPackage({ worktree, base, head, outFile: out, context })));
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  console.error(message);
  console.log(JSON.stringify({ error: message }));
  process.exit(1);
}

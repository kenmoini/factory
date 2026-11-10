import { preflight } from "../preflight";

try {
  console.log(JSON.stringify(await preflight({ cwd: process.cwd() })));
} catch (e) {
  console.log(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
}
process.exit(0);

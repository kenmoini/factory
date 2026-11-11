import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Writes `text` to `path` through a temp file in the same directory, then renames it over `path`, so a reader
 * sees the old or the new content, never a partial file. The mode is the existing file's, else `opts.mode ?? 0o644`.
 */
export function writeFileAtomic(path: string, text: string, opts: { mode?: number } = {}): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`);
  try {
    const mode = existsSync(path) ? statSync(path).mode & 0o777 : opts.mode ?? 0o644;
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, mode); // explicit: the umask must not decide
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

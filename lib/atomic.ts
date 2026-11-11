import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Writes `text` to `path` through a temp file in the same directory, then renames it over `path`, so a reader
 * sees the old or the new content, never a partial file. The mode is the existing file's, else `opts.mode ?? 0o644`.
 * A symlink is followed: the file it points at is replaced and the link stays (a stowed config keeps its target).
 */
export function writeFileAtomic(path: string, text: string, opts: { mode?: number } = {}): void {
  const target = existsSync(path) ? realpathSync(path) : path;
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(target)}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`);
  try {
    let mode = opts.mode ?? 0o644;
    try {
      mode = statSync(target).mode & 0o777;
    } catch {} // a new file: the default mode
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, mode); // explicit: the umask must not decide
    renameSync(tmp, target);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

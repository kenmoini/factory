import { realpathSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { RepoRegistry } from "../repos";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const notFound = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });

/** True when `path` is `root` itself or lies under it. The trailing separator keeps `mockups-evil/` from passing as `mockups/`. */
const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);

/**
 * `GET|HEAD /mockups/<repoSlug>/<rest>` serves `<repoPath>/.factory/mockups/<rest>` as a static file.
 * A directory serves its `index.html` (redirected to the trailing-slash URL first, so relative links resolve).
 * Anything that resolves outside the mockups directory, lexically or through a symlink, is a 404.
 */
export async function mockupsRoute(req: Request, deps: { repos: RepoRegistry }): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const url = new URL(req.url);
  const m = url.pathname.match(/^\/mockups\/([^/]+)\/(.*)$/);
  if (!m) return notFound();
  let slug: string, rest: string;
  try {
    slug = decodeURIComponent(m[1]);
    rest = decodeURIComponent(m[2]);
  } catch {
    return notFound(); // malformed percent-encoding
  }
  if (slug.includes("\0") || rest.includes("\0")) return notFound();
  const entry = deps.repos.bySlug(slug);
  if (!entry) return notFound();

  const root = resolve(entry.repoPath, ".factory", "mockups");
  let target = resolve(root, rest);
  if (!inside(root, target)) return notFound();

  try {
    if (statSync(target).isDirectory()) {
      if (!url.pathname.endsWith("/")) return new Response(null, { status: 301, headers: { Location: `${url.pathname}/${url.search}` } });
      target = join(target, "index.html");
    }
    // symlinks inside the mockups directory must not lead out of it
    if (!inside(realpathSync(root), realpathSync(target)) || !statSync(target).isFile()) return notFound();
  } catch {
    return notFound(); // missing file or directory
  }

  const file = Bun.file(target);
  const headers = {
    "Content-Type": TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": String(file.size),
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  };
  return new Response(req.method === "HEAD" ? null : file, { headers });
}

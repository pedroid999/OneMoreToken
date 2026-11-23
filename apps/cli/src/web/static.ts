import { readFile, stat } from "node:fs/promises";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const MISSING_DIST_PAGE = `<!doctype html><html><body><h1>One More Token</h1><p>Dashboard build not found. Run \`pnpm build\` in apps/web, then restart.</p></body></html>\n`;

export interface WebFile {
  contentType: string;
  body: string;
}

function contentTypeOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return CONTENT_TYPES[path.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolves a request path to a file inside the dashboard build directory.
 * Path traversal escapes are rejected; unknown paths fall back to index.html
 * so client-side routes keep working. Returns null when there is no dist.
 */
export async function readWebFile(
  dist: string | undefined,
  urlPath: string,
): Promise<WebFile | null> {
  if (!dist) return null;
  if (urlPath.includes("\0")) return null;
  const root = normalize(dist);
  const target = normalize(join(root, urlPath === "/" ? "index.html" : urlPath));
  if (!target.startsWith(root)) return null;

  const file = (await exists(target)) ? target : join(root, "index.html");
  if (!(await exists(file))) return null;
  return { contentType: contentTypeOf(file), body: await readFile(file, "utf8") };
}

/** Plain fallback page shown for non-API paths when the dashboard build is missing. */
export function missingDistPage(): string {
  return MISSING_DIST_PAGE;
}

/**
 * Build directory of the dashboard. In the repo this is apps/web/dist next to the CLI package;
 * an install can override it with OMT_WEB_DIST. Returns undefined when it does not exist.
 */
export async function defaultWebDist(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const candidate =
    env.OMT_WEB_DIST ?? fileURLToPath(new URL("../../../web/dist", import.meta.url));
  try {
    return (await stat(candidate)).isDirectory() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

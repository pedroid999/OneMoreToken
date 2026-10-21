import { localApiUrl } from "../ingest-options";

/** Browser mutations accept only canonical loopback HTTP origins (including Vite's port).
 * No Origin is valid for non-browser clients; no CORS headers are emitted.
 */
export function safeIngestOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  const local = localApiUrl(origin);
  return local !== null && local === origin;
}

/** Bound the actual stream, not just the optional/untrusted Content-Length header. */
export async function readIngestJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("invalid ingest options");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16 * 1024) {
        await reader.cancel();
        throw new Error("invalid ingest options");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    reader.releaseLock();
  }
}

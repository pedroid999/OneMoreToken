import type { IngestOptions } from "../ingest-options";
import type { IngestMetrics } from "./service";

/** Fetch injection keeps CLI tests independent of listeners and source data. */
export type IngestFetch = (url: string, init: RequestInit) => Promise<Response>;
const counters = ["files", "persisted", "skipped", "failed", "issues"] as const;

export async function requestIngest(
  url: string,
  options: IngestOptions,
  request: IngestFetch = fetch,
): Promise<IngestMetrics> {
  const response = await request(`${url}/api/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    redirect: "error",
    body: JSON.stringify(options),
  });
  if (!response.ok) throw new Error("ingestion request failed");
  const body: unknown = await response.json();
  if (!body || typeof body !== "object") throw new Error("invalid ingestion response");
  const metrics = {} as IngestMetrics;
  for (const key of counters) {
    const value: unknown = (body as Record<string, unknown>)[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw new Error("invalid ingestion response");
    metrics[key] = value;
  }
  return metrics;
}

export function formatIngestMetrics(metrics: IngestMetrics): string {
  return `omt ingest: ${counters.map((key) => `${key}=${metrics[key]}`).join(" ")}\n`;
}

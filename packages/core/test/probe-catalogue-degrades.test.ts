import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalTool, loadToolCatalogue } from "../src/data/files";

/**
 * Independent verifier probes (spec §7.3, S4): resolution is case-insensitive, a raw name without an
 * alias degrades to its lowercase form, and every alias is a raw name the adapters of this
 * repository really emit (fixtures, snapshots or parsing code), so none is invented.
 */
const ADAPTERS = fileURLToPath(new URL("../../adapters", import.meta.url));

function adapterText(): string {
  const chunks: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules") continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(jsonl|json|sql|snap|ts)$/.test(entry)) chunks.push(readFileSync(path, "utf8"));
    }
  };
  for (const agent of readdirSync(ADAPTERS)) {
    if (agent === "node_modules" || agent === "src") continue;
    const dir = join(ADAPTERS, agent);
    if (!statSync(dir).isDirectory()) continue;
    walk(join(dir, "fixtures"));
    walk(join(dir, "__snapshots__"));
    for (const file of readdirSync(dir)) {
      if (file.endsWith(".ts")) chunks.push(readFileSync(join(dir, file), "utf8"));
    }
  }
  return chunks.join("\n");
}

describe("verifier probes: catalogue resolution (S4)", () => {
  const catalogue = loadToolCatalogue();
  const observed = adapterText().toLowerCase();

  it("resolves case-insensitively and degrades an unlisted raw name to its lowercase form", () => {
    expect(canonicalTool(catalogue, "Read")).toBe("read");
    expect(canonicalTool(catalogue, "BASH")).toBe("bash");
    expect(canonicalTool(catalogue, "exec")).toBe("bash");
    expect(canonicalTool(catalogue, "spawn_agent")).toBe("task");
    expect(canonicalTool(catalogue, "Glob")).toBe("glob");
    expect(canonicalTool(catalogue, "WebSearch")).toBe("websearch");
    expect(canonicalTool(catalogue, "MCP__Tool__Thing")).toBe("mcp__tool__thing");
  });

  it("lists no invented alias: every alias appears in an adapter fixture, snapshot or parser", () => {
    for (const tool of catalogue.tools) {
      for (const alias of tool.aliases) {
        expect(observed, `${alias} must exist in the adapters`).toContain(alias.toLowerCase());
      }
    }
  });
});

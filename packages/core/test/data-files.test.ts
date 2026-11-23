import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  canonicalTool,
  DATA_DIR,
  loadPricing,
  loadSubscriptions,
  loadToolCatalogue,
  PricingFileSchema,
  SubscriptionsFileSchema,
  ToolCatalogueSchema,
} from "../src/data/files";
import { loadPresetViews, SavedViewSchema } from "../src/data/views";

describe("data/pricing.json", () => {
  it("validates against the pricing schema", () => {
    expect(() => loadPricing()).not.toThrow();
  });

  it("rejects malformed policy, observation dates, provenance and tiers", () => {
    const entry = {
      model: "m",
      provider: "p",
      validFrom: "2026-10-21",
      validTo: null,
      inputPerMTok: 1,
      outputPerMTok: 2,
      cacheReadPerMTok: 0.1,
      cacheWritePerMTok: 1.25,
    };
    const current = {
      version: 1,
      currency: "USD",
      basis: "current-reference",
      observedAt: "2026-10-21",
      entries: [entry],
    };
    expect(PricingFileSchema.safeParse(current).success).toBe(true);
    for (const invalid of [
      { ...current, observedAt: undefined },
      { ...current, observedAt: "2026-02-30" },
      { ...current, basis: "guessed" },
      { ...current, basis: undefined },
      ...[
        { validTo: "2026-10-20" },
        { validFrom: "2026-10-22" },
        { sources: ["not a URL"] },
        { cacheWriteLongPerMTok: -1 },
        { longContext: { inputTokenThreshold: -1 } },
        { longContext: { inputTokenThreshold: 272000, inputPerMTok: 4 } },
      ].map((change) => ({ ...current, entries: [{ ...entry, ...change }] })),
    ])
      expect(PricingFileSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects overlapping validity ranges for the same model and provider", () => {
    const entry = {
      model: "m",
      provider: "p",
      inputPerMTok: 1,
      outputPerMTok: 2,
      cacheReadPerMTok: 0.1,
      cacheWritePerMTok: 1.25,
    };
    const result = PricingFileSchema.safeParse({
      version: 1,
      currency: "USD",
      entries: [
        { ...entry, validFrom: "2026-01-01", validTo: "2026-06-30" },
        { ...entry, validFrom: "2026-06-01", validTo: null },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/overlapping validity for m \/ p/);
  });

  it("rejects negative prices", () => {
    const result = PricingFileSchema.safeParse({
      version: 1,
      currency: "USD",
      entries: [
        {
          model: "m",
          provider: "p",
          validFrom: "2026-01-01",
          validTo: null,
          inputPerMTok: -1,
          outputPerMTok: 2,
          cacheReadPerMTok: 0,
          cacheWritePerMTok: 0,
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("data/subscriptions.json", () => {
  it("validates against the subscriptions schema", () => {
    expect(() => loadSubscriptions()).not.toThrow();
  });

  it("carries the OpenCode Go limits from spec §5.1", () => {
    const go = loadSubscriptions().plans.find((p) => p.id === "opencode-go");
    expect(go?.windows).toEqual([
      { kind: "five_hours", limit: { unit: "usd", value: 12 } },
      { kind: "weekly", limit: { unit: "usd", value: 30 } },
      { kind: "monthly", limit: { unit: "usd", value: 60 } },
    ]);
  });

  it("marks Claude windows as estimated: no public token limit (spec §5.1)", () => {
    const claude = loadSubscriptions().plans.filter((p) => p.provider === "anthropic");
    expect(claude.length).toBeGreaterThan(0);
    for (const plan of claude) {
      expect(plan.windows.map((w) => w.kind)).toEqual(["five_hours", "weekly"]);
      for (const w of plan.windows) expect(w.limit).toEqual({ unit: "estimated" });
    }
  });

  it("carries ChatGPT Plus with estimated 5 h and weekly windows for Codex usage", () => {
    const plus = loadSubscriptions().plans.find((p) => p.id === "chatgpt-plus");
    expect(plus).toMatchObject({ provider: "openai", monthlyPriceUsd: 20 });
    expect(plus?.windows).toEqual([
      { kind: "five_hours", limit: { unit: "estimated" } },
      { kind: "weekly", limit: { unit: "estimated" } },
    ]);
  });

  it("rejects duplicated plan ids", () => {
    const plan = { id: "x", label: "X", provider: "p", windows: [] };
    const result = SubscriptionsFileSchema.safeParse({ version: 1, plans: [plan, plan] });
    expect(result.success).toBe(false);
  });
});

const ADAPTERS_DIR = fileURLToPath(new URL("../../adapters", import.meta.url));

/** Raw tool names any adapter of this repository actually parses, from its fixtures and snapshots. */
function adapterToolNames(): Set<string> {
  const names = new Set<string>();
  const read = (path: string) => {
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(/"(?:tool|name)"\s*:\s*"([^"]+)"/g)) {
      if (match[1]) names.add(match[1].toLowerCase());
    }
  };
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules") continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(jsonl|json|sql|ts|snap)$/.test(entry)) read(path);
    }
  };
  for (const adapter of readdirSync(ADAPTERS_DIR)) {
    if (adapter === "node_modules" || adapter === "src") continue;
    const dir = join(ADAPTERS_DIR, adapter);
    if (!statSync(dir).isDirectory()) continue;
    for (const sub of ["fixtures", "__snapshots__"]) walk(join(dir, sub));
    for (const file of readdirSync(dir)) {
      if (file.endsWith(".ts")) read(join(dir, file));
    }
  }
  return names;
}

function writeCatalogue(body: unknown): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "omt-tools-"));
  const path = join(dir, "tools.json");
  writeFileSync(path, JSON.stringify(body));
  return { path, dir };
}

describe("data/tools.json (canonical tool catalogue, spec §7.3)", () => {
  it("validates against the catalogue schema", () => {
    expect(() => loadToolCatalogue()).not.toThrow();
    expect(loadToolCatalogue().version).toBe(1);
  });

  it("carries the canonical ids of spec §7.3 without duplicating an id or an alias", () => {
    const catalogue = loadToolCatalogue();
    const ids = catalogue.tools.map((tool) => tool.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9_-]{0,63}$/);
    const aliases = catalogue.tools.flatMap((tool) => tool.aliases.map((a) => a.toLowerCase()));
    expect(new Set(aliases).size).toBe(aliases.length);
    for (const tool of catalogue.tools) expect(tool.aliases.length).toBeGreaterThan(0);
    expect(ids).toEqual(expect.arrayContaining(["bash", "edit", "grep", "read", "task"]));
  });

  it("invents no alias: every alias is a raw name an adapter of this repository parses", () => {
    const observed = adapterToolNames();
    for (const tool of loadToolCatalogue().tools) {
      for (const alias of tool.aliases) {
        expect(observed.has(alias.toLowerCase())).toBe(true);
      }
    }
  });

  it("maps the raw names of every adapter case-insensitively and keeps unlisted ones lowercase", () => {
    const catalogue = loadToolCatalogue();
    expect(canonicalTool(catalogue, "Read")).toBe("read");
    expect(canonicalTool(catalogue, "read")).toBe("read");
    expect(canonicalTool(catalogue, "READ")).toBe("read");
    expect(canonicalTool(catalogue, "Bash")).toBe("bash");
    expect(canonicalTool(catalogue, "exec")).toBe("bash");
    expect(canonicalTool(catalogue, "execute")).toBe("bash");
    expect(canonicalTool(catalogue, "spawn_agent")).toBe("task");
    expect(canonicalTool(catalogue, "edit")).toBe("edit");
    // A raw name with no alias degrades to its lowercase form instead of disappearing.
    expect(canonicalTool(catalogue, "Glob")).toBe("glob");
    expect(canonicalTool(catalogue, "mcp__something")).toBe("mcp__something");
  });

  it("rejects a version other than 1, a bad id, an empty alias list and unknown keys", () => {
    const scratch = writeCatalogue({ version: 1, tools: [{ id: "read", aliases: ["read"] }] });
    try {
      expect(() => loadToolCatalogue(scratch.path)).not.toThrow();
    } finally {
      rmSync(scratch.dir, { recursive: true, force: true });
    }
    for (const invalid of [
      { version: 2, tools: [{ id: "read", aliases: ["read"] }] },
      { version: 1, tools: [{ id: "Read", aliases: ["read"] }] },
      { version: 1, tools: [{ id: "read", aliases: [] }] },
      { version: 1, tools: [{ id: "read", aliases: [""] }] },
      { version: 1, tools: [{ id: "read", aliases: ["read"], label: "Read" }] },
      { version: 1, tools: [{ id: "read", aliases: ["read"] }], extra: true },
      { version: 1 },
      {
        version: 1,
        tools: [
          { id: "read", aliases: ["read"] },
          { id: "read", aliases: ["view"] },
        ],
      },
      {
        version: 1,
        tools: [
          { id: "read", aliases: ["read"] },
          { id: "view", aliases: ["Read"] },
        ],
      },
      {
        version: 1,
        tools: [{ id: "read", aliases: ["read", "read"] }],
      },
    ]) {
      expect(ToolCatalogueSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("rejects an aliases list shared by two tools", () => {
    const result = ToolCatalogueSchema.safeParse({
      version: 1,
      tools: [
        { id: "bash", aliases: ["exec"] },
        { id: "shell", aliases: ["Exec"] },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/alias exec/);
  });
});

describe("data/views/*.json (saved view presets)", () => {
  it("validates every preset file and keeps ids unique, filename-aligned and i18n-keyed", () => {
    const files = readdirSync(join(DATA_DIR, "views")).filter((file) => file.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(5);
    const presets = loadPresetViews();
    expect(presets.map((view) => `${view.id}.json`).sort()).toEqual(files.sort());
    for (const view of presets) {
      expect(view.name).toMatch(/^explorer\.presets\.[a-zA-Z0-9]+\.name$/);
      if (view.description !== undefined)
        expect(view.description).toMatch(/^explorer\.presets\.[a-zA-Z0-9]+\.description$/);
    }
  });

  it("rejects a preset whose id does not match its file name or whose name is not an i18n key", () => {
    const dir = mkdtempSync(join(tmpdir(), "omt-presets-"));
    try {
      writeFileSync(join(dir, "other.json"), JSON.stringify(view));
      expect(() => loadPresetViews(dir)).toThrow(/does not match/);
      rmSync(join(dir, "other.json"));
      writeFileSync(join(dir, "cost.json"), JSON.stringify({ ...view, name: "Cost" }));
      expect(() => loadPresetViews(dir)).toThrow(/i18n key/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const view = {
    schema: "omt.saved-view/1",
    id: "cost",
    name: "explorer.presets.cost.name",
    query: {
      metrics: ["computedCost"],
      dimensions: ["model"],
      filters: [{ dimension: "agent", op: "in", values: ["pi"] }],
      range: "last30Days",
    },
    chart: { type: "bar", encoding: { x: "model", y: "computedCost" } },
    spec: {
      $schema: "https://vega.github.io/schema/vega-lite/v6.json",
      data: { name: "table" },
      mark: "bar",
    },
  };

  it("accepts relative and absolute ranges and Vega for treemap/sankey", () => {
    expect(SavedViewSchema.safeParse(view).success).toBe(true);
    expect(
      SavedViewSchema.safeParse({
        ...view,
        query: {
          ...view.query,
          range: { from: "2026-01-01T00:00:00Z", to: "2026-02-01T00:00:00Z" },
        },
      }).success,
    ).toBe(true);
    expect(
      SavedViewSchema.safeParse({
        ...view,
        chart: { type: "treemap", encoding: { color: "model", size: "computedCost" } },
        spec: { $schema: "https://vega.github.io/schema/vega/v6.json", data: [{ name: "table" }] },
      }).success,
    ).toBe(true);
  });

  it.each([
    ["unknown schema version", { schema: "omt.saved-view/2" }],
    ["invalid id", { id: "../escape" }],
    ["uppercase id", { id: "Cost" }],
    ["extra key", { owner: "me" }],
    ["unknown metric", { query: { ...view.query, metrics: ["tokens"] } }],
    ["unknown dimension", { query: { ...view.query, dimensions: ["user"] } }],
    [
      "unknown filter op",
      { query: { ...view.query, filters: [{ dimension: "agent", op: "like", values: ["%"] }] } },
    ],
    ["from/to inside the query", { query: { ...view.query, from: "2026-01-01T00:00:00Z" } }],
    ["unknown relative range", { query: { ...view.query, range: "forever" } }],
    [
      "reversed absolute range",
      {
        query: {
          ...view.query,
          range: { from: "2026-02-01T00:00:00Z", to: "2026-01-01T00:00:00Z" },
        },
      },
    ],
    ["unknown chart type", { chart: { type: "pie", encoding: {} } }],
    [
      "encoding outside the query",
      { chart: { type: "bar", encoding: { x: "agent", y: "computedCost" } } },
    ],
    ["Vega-Lite treemap", { chart: { type: "treemap", encoding: {} } }],
    [
      "Vega bar chart",
      { spec: { ...view.spec, $schema: "https://vega.github.io/schema/vega/v6.json" } },
    ],
    [
      "remote spec schema",
      { spec: { ...view.spec, $schema: "https://example.com/vega-lite/v6.json" } },
    ],
    ["remote data url", { spec: { ...view.spec, data: { url: "https://example.com/x.json" } } }],
    ["inline data values", { spec: { ...view.spec, layer: [{ data: { values: [{ a: 1 }] } }] } }],
  ])("rejects %s", (_label, change) => {
    expect(SavedViewSchema.safeParse({ ...view, ...change }).success).toBe(false);
  });
});

describe("data directory resolution", () => {
  it("prefers OMT_DATA_DIR over the repo-relative default", async () => {
    const { resolveDataDir } = await import("../src/data/files");
    const fake = mkdtempSync(join(tmpdir(), "omt-data-"));
    try {
      writeFileSync(
        join(fake, "pricing.json"),
        readFileSync(join(DATA_DIR, "pricing.json"), "utf8"),
      );
      expect(resolveDataDir({ OMT_DATA_DIR: fake })).toBe(fake);
      expect(() =>
        loadPricing(join(resolveDataDir({ OMT_DATA_DIR: fake }), "pricing.json")),
      ).not.toThrow();
    } finally {
      rmSync(fake, { recursive: true, force: true });
    }
  });

  it("keeps the repo-relative default when the env var is unset", async () => {
    const { resolveDataDir } = await import("../src/data/files");
    expect(resolveDataDir({})).toBe(DATA_DIR);
  });
});

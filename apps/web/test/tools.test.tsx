// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../src/i18n/en.json";
import es from "../src/i18n/es.json";
import { createI18n } from "../src/i18n/i18n";
import { PreferencesProvider } from "../src/prefs/usePreferences";
import type { ToolsReport } from "../src/tools/contract";
import { ToolsView } from "../src/tools/ToolsView";
import { type DownloadSeam, fakeColorScheme, installDownloadSeam, memoryStorage } from "./helpers";

const from = "2026-01-01T00:00:00.000Z";
const to = "2026-01-08T00:00:00.000Z";
const TOOLS = `/api/tools?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

const tokenTotals = (total: number) => ({
  input: total,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total,
});

const answer = (patch: Partial<ToolsReport> = {}): ToolsReport => ({
  period: { from, to },
  tools: [
    {
      tool: "read",
      rawNames: ["Read", "read"],
      calls: 12,
      errors: 1,
      errorStatusKnown: true,
      turns: 10,
      sharedTurns: 6,
      durationKnownMs: 30_000,
      durationAvgKnownMs: 2_500,
      tokens: tokenTotals(2_000_000),
      computedCostUsd: 4,
      reportedCostUsd: null,
      costKnownTurns: 9,
      costUnknownTurns: 1,
    },
    {
      tool: "bash",
      rawNames: ["bash"],
      calls: 5,
      errors: 0,
      errorStatusKnown: true,
      turns: 4,
      sharedTurns: 2,
      durationKnownMs: 6_000,
      durationAvgKnownMs: 1_200,
      tokens: tokenTotals(500_000),
      computedCostUsd: null,
      reportedCostUsd: 1.5,
      costKnownTurns: 4,
      costUnknownTurns: 0,
    },
    {
      // Codex records no tool errors: the count is unknown, never zero (spec §7.3, S5).
      tool: "exec",
      rawNames: ["exec_command"],
      calls: 7,
      errors: 0,
      errorStatusKnown: false,
      turns: 3,
      sharedTurns: 1,
      durationKnownMs: 8_000,
      durationAvgKnownMs: null,
      tokens: tokenTotals(0),
      computedCostUsd: null,
      reportedCostUsd: null,
      costKnownTurns: 0,
      costUnknownTurns: 3,
    },
  ],
  daily: [
    { day: "2026-01-02", tool: "read", tokens: 1_500_000 },
    { day: "2026-01-02", tool: "bash", tokens: 500_000 },
    { day: "2026-01-03", tool: "read", tokens: 500_000 },
    { day: "2026-01-03", tool: "exec", tokens: 0 },
  ],
  byAgent: [
    {
      agent: "claude-code",
      rawName: "Read",
      tool: "read",
      calls: 8,
      errors: 1,
      errorStatusKnown: true,
    },
    {
      agent: "claude-code",
      rawName: "read",
      tool: "read",
      calls: 4,
      errors: 0,
      errorStatusKnown: true,
    },
    { agent: "pi", rawName: "bash", tool: "bash", calls: 5, errors: 0, errorStatusKnown: true },
    {
      agent: "codex",
      rawName: "exec_command",
      tool: "exec",
      calls: 7,
      errors: 0,
      errorStatusKnown: false,
    },
  ],
  ...patch,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fetcher = vi.fn<typeof fetch>();
let requests: string[] = [];
let body: () => Response | Promise<Response>;
let seam: DownloadSeam;

beforeEach(() => {
  seam = installDownloadSeam();
  window.history.replaceState(
    null,
    "",
    `/tools?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
  requests = [];
  body = () => json(answer());
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset();
  fetcher.mockImplementation(async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith("/api/tools?")) return body();
    return json({ error: "not found" }, 404);
  });
});
afterEach(() => {
  cleanup();
  seam.restore();
  vi.unstubAllGlobals();
});

async function view(language: "en" | "es" = "en") {
  const i18n = await createI18n({ storage: memoryStorage(), browserLanguages: [language] });
  const scheme = fakeColorScheme(false);
  render(
    <I18nextProvider i18n={i18n}>
      <PreferencesProvider
        env={{
          storage: memoryStorage(),
          root: document.documentElement,
          matchMedia: scheme.matchMedia,
        }}
      >
        <ToolsView />
      </PreferencesProvider>
    </I18nextProvider>,
  );
  return i18n;
}

const region = (name: string) => screen.findByRole("region", { name });
const rows = (scope: HTMLElement, name: string) =>
  within(within(scope).getByRole("table", { name })).getAllByRole("row").slice(1) as HTMLElement[];
/** Cell texts; the M-token formatter separates the unit with a no-break space. */
const cells = (row: HTMLElement) =>
  [...row.querySelectorAll("th, td")].map((c) => c.textContent?.replace(/\u00a0/g, " "));

describe("Tools view (T6, S3, S5, S7)", () => {
  it("requests the period's report only", async () => {
    await view();
    await region(en.tools.table.title);
    expect(requests).toEqual([TOOLS]);
    expect(screen.getByRole("heading", { level: 1, name: en.tools.title })).toBeTruthy();
  });

  it("summarizes the calls and the tokens of the turns that used the tools", async () => {
    await view();
    const headline = await screen.findByText(
      en.tools.headline
        .replace("{{calls}}", "24")
        .replace("{{tools}}", "3")
        .replace("{{tokens}}", "2.5 M"),
    );
    expect(headline).toBeTruthy();
  });

  it("warns that turn tokens and costs overlap between rows", async () => {
    await view();
    const warning = await screen.findByRole("note");
    expect(warning.textContent).toBe(en.tools.overlap);
  });

  it("lists every tool with calls, errors, durations, turns, tokens and cost", async () => {
    await view();
    const table = await region(en.tools.table.title);
    const [read, bash, exec] = rows(table, en.tools.table.title) as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    expect(cells(read)).toEqual([
      "read",
      "12",
      "1",
      "30 s",
      "2.5 s",
      "10",
      "6",
      "2.0 M",
      "$4.00",
      en.tools.noValue,
    ]);
    expect(cells(bash)).toEqual([
      "bash",
      "5",
      "0",
      "6 s",
      "1.2 s",
      "4",
      "2",
      "0.5 M",
      en.tools.noValue,
      "$1.50",
    ]);
    // Codex records no tool errors: the cell is unknown, never 0 (S5).
    expect(cells(exec)).toEqual([
      "exec",
      "7",
      en.tools.unknown,
      "8 s",
      en.tools.noValue,
      "3",
      "1",
      "0.0 M",
      en.tools.noValue,
      en.tools.noValue,
    ]);
  });

  it("explains that an agent without error records shows the count as unknown", async () => {
    await view();
    const table = await region(en.tools.table.title);
    expect(within(table).getByText(en.tools.errorsUnknownNote)).toBeTruthy();
  });

  it("draws the daily tokens of the top tools as an accessible chart", async () => {
    await view();
    const chart = await region(en.tools.chart.title);
    expect(await within(chart).findByRole("img", { name: en.tools.chart.chartName })).toBeTruthy();
    expect(within(chart).getByText(en.tools.chart.note.replace("{{count}}", "3"))).toBeTruthy();
  });

  it("keeps the raw name each agent records so the mapping can be audited", async () => {
    await view();
    const raw = await region(en.tools.raw.title);
    expect(within(raw).getByText(en.tools.raw.body)).toBeTruthy();
    const [first, , pi, codex] = rows(raw, en.tools.raw.title) as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    expect(cells(first)).toEqual([en.session.agentName.claudeCode, "Read", "read", "8", "1"]);
    expect(cells(pi)).toEqual([en.session.agentName.pi, "bash", "bash", "5", "0"]);
    expect(cells(codex)).toEqual([
      en.session.agentName.codex,
      "exec_command",
      "exec",
      "7",
      en.tools.unknown,
    ]);
  });

  it("says when a section has nothing in the period", async () => {
    body = () => json(answer({ daily: [], byAgent: [] }));
    await view();
    const chart = await region(en.tools.chart.title);
    expect(within(chart).getByText(en.tools.chart.empty)).toBeTruthy();
    const raw = await region(en.tools.raw.title);
    expect(within(raw).getByText(en.tools.raw.empty)).toBeTruthy();
  });

  it("invites to ingest when the period has no tool calls", async () => {
    body = () => json(answer({ tools: [], daily: [], byAgent: [] }));
    await view();
    expect(await screen.findByText(en.tools.empty.title)).toBeTruthy();
    expect(screen.getByText("pnpm omt ingest").tagName).toBe("CODE");
    expect(screen.queryByRole("region", { name: en.tools.table.title })).toBeNull();
  });

  it("shows a loading state until the report arrives", async () => {
    body = () => new Promise<Response>(() => {});
    await view();
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByText(en.common.loading)).toBeTruthy();
  });

  it("explains a failure and retries", async () => {
    body = () => json({ error: "tools unavailable" }, 500);
    await view();
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(en.tools.error)).toBeTruthy();
    body = () => json(answer());
    fireEvent.click(within(alert).getByRole("button", { name: en.common.retry }));
    expect(await region(en.tools.table.title)).toBeTruthy();
  });

  it("changes the period through the URL", async () => {
    await view();
    await region(en.tools.table.title);
    fireEvent.click(screen.getByRole("radio", { name: en.summary.last30Days }));
    const params = new URLSearchParams(window.location.search);
    expect(Date.parse(params.get("to") ?? "") - Date.parse(params.get("from") ?? "")).toBe(
      30 * 86_400_000,
    );
    expect(requests.at(-1)).toContain("/api/tools?from=");
    expect(requests.at(-1)).not.toBe(TOOLS);
  });

  it("switches language hot, keeping the data without refetching", async () => {
    const i18n = await view();
    await region(en.tools.table.title);
    const before = requests.length;
    await act(async () => {
      await i18n.changeLanguage("es");
    });
    expect(screen.getByRole("heading", { level: 1, name: es.tools.title })).toBeTruthy();
    const table = await region(es.tools.table.title);
    const [read] = rows(table, es.tools.table.title) as [HTMLElement];
    expect(cells(read)).toContain("2,0 M");
    expect(requests.length).toBe(before);
  });
});

describe("Tools exports (T6, S7)", () => {
  const csv = (scope: HTMLElement, name: string) =>
    within(scope).getByRole("button", { name: en.export.csvAria.replace("{{name}}", name) });

  it("offers PNG and SVG for the daily tokens chart", async () => {
    await view();
    const chart = await region(en.tools.chart.title);
    expect(
      within(chart).getByRole("button", {
        name: en.export.pngAria.replace("{{name}}", en.tools.chart.title),
      }).textContent,
    ).toBe(en.export.png);
    expect(
      within(chart).getByRole("button", {
        name: en.export.svgAria.replace("{{name}}", en.tools.chart.title),
      }).textContent,
    ).toBe(en.export.svg);
  });

  it("downloads the tool table as CSV with raw values and unknown errors empty", async () => {
    await view();
    fireEvent.click(csv(await region(en.tools.table.title), en.tools.table.title));
    await waitFor(() => expect(seam.downloads).toHaveLength(1));
    const columns = en.tools.column as Record<string, string>;
    const header = [
      columns.tool,
      columns.calls,
      columns.errors,
      columns.duration,
      columns.avgDuration,
      columns.turns,
      columns.sharedTurns,
      columns.tokens,
      columns.computedCost,
      columns.reportedCost,
    ].join(",");
    expect(seam.downloads[0]?.name).toBe("tools-by-tool-2026-01-01-2026-01-08.csv");
    expect(await seam.text(seam.downloads[0])).toBe(
      `${[
        header,
        "read,12,1,30000,2500,10,6,2000000,4,",
        "bash,5,0,6000,1200,4,2,500000,,1.5",
        // An unknown error status exports no number at all (S5).
        "exec,7,,8000,,3,1,0,,",
      ].join("\r\n")}\r\n`,
    );
  });

  it("downloads the raw names table as CSV", async () => {
    await view();
    fireEvent.click(csv(await region(en.tools.raw.title), en.tools.raw.title));
    await waitFor(() => expect(seam.downloads).toHaveLength(1));
    const columns = en.tools.column as Record<string, string>;
    expect(seam.downloads[0]?.name).toBe("tools-raw-names-2026-01-01-2026-01-08.csv");
    expect(await seam.text(seam.downloads[0])).toBe(
      `${[
        [columns.agent, columns.rawName, columns.tool, columns.calls, columns.errors].join(","),
        "claude-code,Read,read,8,1",
        "claude-code,read,read,4,0",
        "pi,bash,bash,5,0",
        "codex,exec_command,exec,7,",
      ].join("\r\n")}\r\n`,
    );
  });
});

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentsView } from "../src/agents/AgentsView";
import type { AgentClassRow, AgentsReport } from "../src/agents/contract";
import en from "../src/i18n/en.json";
import es from "../src/i18n/es.json";
import { createI18n } from "../src/i18n/i18n";
import { PreferencesProvider } from "../src/prefs/usePreferences";
import { type DownloadSeam, fakeColorScheme, installDownloadSeam, memoryStorage } from "./helpers";

const from = "2026-01-01T00:00:00.000Z";
const to = "2026-01-08T00:00:00.000Z";
const AGENTS = `/api/agents?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

const tokenTotals = (total: number) => ({
  input: total,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total,
});

const row = (patch: Partial<AgentClassRow> = {}): AgentClassRow => ({
  taskClass: "feature",
  source: "derived",
  agent: "claude-code",
  sessions: 3,
  turns: 30,
  tokens: tokenTotals(3_000_000),
  computedCostUsd: 6,
  reportedCostUsd: null,
  cacheHitRatio: 0.5,
  ...patch,
});

const answer = (patch: Partial<AgentsReport> = {}): AgentsReport => ({
  period: { from, to },
  classes: ["feature", "inline", "unknown"],
  rows: [
    row(),
    row({
      agent: "opencode",
      sessions: 1,
      turns: 8,
      tokens: tokenTotals(500_000),
      computedCostUsd: null,
      reportedCostUsd: 1.25,
      cacheHitRatio: null,
    }),
    row({
      taskClass: "inline",
      source: "corrected",
      sessions: 2,
      turns: 10,
      tokens: tokenTotals(1_000_000),
      computedCostUsd: 2,
      reportedCostUsd: 2.5,
      cacheHitRatio: 0.8,
    }),
    row({
      taskClass: "unknown",
      agent: "codex",
      sessions: 4,
      turns: 12,
      tokens: tokenTotals(750_000),
      computedCostUsd: null,
      reportedCostUsd: null,
      cacheHitRatio: 0,
    }),
  ],
  totals: { derivedSessions: 8, correctedSessions: 2 },
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
    `/agents?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
  requests = [];
  body = () => json(answer());
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset();
  fetcher.mockImplementation(async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith("/api/agents?")) return body();
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
        <AgentsView />
      </PreferencesProvider>
    </I18nextProvider>,
  );
  return i18n;
}

const region = (name: string) => screen.findByRole("region", { name });
const rows = (scope: HTMLElement, name: string) =>
  within(within(scope).getByRole("table", { name })).getAllByRole("row").slice(1) as HTMLElement[];
const cells = (row: HTMLElement) =>
  [...row.querySelectorAll("th, td")].map((c) => c.textContent?.replace(/\u00a0/g, " "));

describe("Agents view (T7, S2, S6)", () => {
  it("requests the period's report only", async () => {
    await view();
    await region(en.agents.comparison.title);
    expect(requests).toEqual([AGENTS]);
    expect(screen.getByRole("heading", { level: 1, name: en.agents.title })).toBeTruthy();
  });

  it("counts the sessions with a derived class apart from the corrected ones", async () => {
    await view();
    expect(
      await screen.findByText(
        en.agents.headline.replace("{{derived}}", "8").replace("{{corrected}}", "2"),
      ),
    ).toBeTruthy();
  });

  it("compares every task class across agents, telling derived from corrected", async () => {
    await view();
    const table = await region(en.agents.comparison.title);
    const [claude, opencode, corrected, codex] = rows(table, en.agents.comparison.title) as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    expect(cells(claude)).toEqual([
      en.taskClass.feature,
      en.taskClass.source.derived,
      en.session.agentName.claudeCode,
      "3",
      "30",
      "3.0 M",
      "$6.00",
      en.agents.noCost,
      "50.0%",
    ]);
    expect(cells(opencode)).toEqual([
      en.taskClass.feature,
      en.taskClass.source.derived,
      en.session.agentName.opencode,
      "1",
      "8",
      "0.5 M",
      en.agents.noCost,
      "$1.25",
      en.agents.notAvailable,
    ]);
    expect(cells(corrected)).toEqual([
      en.taskClass.inline,
      en.taskClass.source.corrected,
      en.session.agentName.claudeCode,
      "2",
      "10",
      "1.0 M",
      "$2.00",
      "$2.50",
      "80.0%",
    ]);
    expect(cells(codex)).toEqual([
      en.taskClass.unknown,
      en.taskClass.source.derived,
      en.session.agentName.codex,
      "4",
      "12",
      "0.8 M",
      en.agents.noCost,
      en.agents.noCost,
      "0.0%",
    ]);
  });

  it("filters the comparison by task class", async () => {
    await view();
    const filter = await screen.findByRole("radiogroup", { name: en.agents.filter.label });
    fireEvent.click(within(filter).getByRole("radio", { name: en.taskClass.inline }));
    const table = await region(en.agents.comparison.title);
    const visible = rows(table, en.agents.comparison.title) as HTMLElement[];
    expect(visible).toHaveLength(1);
    expect(cells(visible[0] as HTMLElement)[1]).toBe(en.taskClass.source.corrected);
    fireEvent.click(within(filter).getByRole("radio", { name: en.agents.filter.all }));
    expect(rows(await region(en.agents.comparison.title), en.agents.comparison.title)).toHaveLength(
      4,
    );
  });

  it("says when the chosen class matches no row", async () => {
    body = () => json(answer({ rows: [row()] }));
    await view();
    const filter = await screen.findByRole("radiogroup", { name: en.agents.filter.label });
    fireEvent.click(within(filter).getByRole("radio", { name: en.taskClass.unknown }));
    expect(await screen.findByText(en.agents.comparison.filtered)).toBeTruthy();
  });

  it("draws the sessions of each task class per agent as an accessible chart", async () => {
    await view();
    const comparison = await region(en.agents.comparison.title);
    expect(
      await within(comparison).findByRole("img", { name: en.agents.chart.chartName }),
    ).toBeTruthy();
  });

  it("invites to ingest when no session has a task class", async () => {
    body = () => json(answer({ rows: [], totals: { derivedSessions: 0, correctedSessions: 0 } }));
    await view();
    expect(await screen.findByText(en.agents.empty.title)).toBeTruthy();
    expect(screen.getByText("pnpm omt ingest").tagName).toBe("CODE");
    expect(screen.queryByRole("region", { name: en.agents.comparison.title })).toBeNull();
  });

  it("shows a loading state until the report arrives", async () => {
    body = () => new Promise<Response>(() => {});
    await view();
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByText(en.common.loading)).toBeTruthy();
  });

  it("explains a failure and retries", async () => {
    body = () => json({ error: "agents unavailable" }, 500);
    await view();
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(en.agents.error)).toBeTruthy();
    body = () => json(answer());
    fireEvent.click(within(alert).getByRole("button", { name: en.common.retry }));
    expect(await region(en.agents.comparison.title)).toBeTruthy();
  });

  it("changes the period through the URL", async () => {
    await view();
    await region(en.agents.comparison.title);
    fireEvent.click(screen.getByRole("radio", { name: en.summary.last30Days }));
    const params = new URLSearchParams(window.location.search);
    expect(Date.parse(params.get("to") ?? "") - Date.parse(params.get("from") ?? "")).toBe(
      30 * 86_400_000,
    );
    expect(requests.at(-1)).not.toBe(AGENTS);
  });

  it("switches language hot, keeping the data without refetching", async () => {
    const i18n = await view();
    await region(en.agents.comparison.title);
    const before = requests.length;
    await act(async () => {
      await i18n.changeLanguage("es");
    });
    expect(screen.getByRole("heading", { level: 1, name: es.agents.title })).toBeTruthy();
    const table = await region(es.agents.comparison.title);
    const [first] = rows(table, es.agents.comparison.title) as [HTMLElement];
    expect(cells(first)).toContain("3,0 M");
    expect(requests.length).toBe(before);
  });
});

describe("Agents exports (T7, S7)", () => {
  const csv = (scope: HTMLElement, name: string) =>
    within(scope).getByRole("button", { name: en.export.csvAria.replace("{{name}}", name) });

  it("offers PNG and SVG for the class comparison chart", async () => {
    await view();
    const comparison = await region(en.agents.comparison.title);
    expect(
      within(comparison).getByRole("button", {
        name: en.export.pngAria.replace("{{name}}", en.agents.chart.title),
      }),
    ).toBeTruthy();
    expect(
      within(comparison).getByRole("button", {
        name: en.export.svgAria.replace("{{name}}", en.agents.chart.title),
      }),
    ).toBeTruthy();
  });

  it("downloads the comparison as CSV with the source of every class", async () => {
    await view();
    fireEvent.click(csv(await region(en.agents.comparison.title), en.agents.comparison.title));
    await waitFor(() => expect(seam.downloads).toHaveLength(1));
    const columns = en.agents.column as Record<string, string>;
    const header = [
      columns.taskClass,
      columns.source,
      columns.agent,
      columns.sessions,
      columns.turns,
      columns.tokens,
      columns.computedCost,
      columns.reportedCost,
      columns.cacheHitRatio,
    ].join(",");
    expect(seam.downloads[0]?.name).toBe("agents-by-task-class-2026-01-01-2026-01-08.csv");
    expect(await seam.text(seam.downloads[0])).toBe(
      `${[
        header,
        "feature,derived,claude-code,3,30,3000000,6,,0.5",
        "feature,derived,opencode,1,8,500000,,1.25,",
        "inline,corrected,claude-code,2,10,1000000,2,2.5,0.8",
        "unknown,derived,codex,4,12,750000,,,0",
      ].join("\r\n")}\r\n`,
    );
  });
});

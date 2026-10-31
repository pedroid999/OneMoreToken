// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDetail, SessionList } from "../../cli/src/sessions/contract";
import en from "../src/i18n/en.json";
import es from "../src/i18n/es.json";
import { createI18n } from "../src/i18n/i18n";
import { PreferencesProvider } from "../src/prefs/usePreferences";
import { dateTimeFormat } from "../src/session/labels";
import { SessionView } from "../src/views/SessionView";
import { fakeColorScheme, memoryStorage } from "./helpers";

const from = "2026-01-01T00:00:00.000Z";
const to = "2026-01-08T00:00:00.000Z";
const id = (n: string) => `${n.repeat(64)}:session:${n.repeat(64)}`;
const PARENT = id("a");
const CHILD = id("b");
const GRANDPARENT = id("c");
const cost = (usd: number | null, known: number, unknown: number) => ({ usd, known, unknown });

const item = (patch: Partial<SessionList["sessions"][number]> = {}) => ({
  id: PARENT,
  agent: "claude-code",
  cwd: "project-x",
  branch: "main",
  startedAt: "2026-01-02T10:00:00.000Z",
  endedAt: "2026-01-02T11:00:00.000Z",
  parentId: null,
  turns: 4,
  usageTurns: 2,
  tokens: {
    input: 1_000_000,
    output: 200_000,
    cacheRead: 300_000,
    cacheWrite: 0,
    total: 1_500_000,
  },
  costs: { reported: cost(null, 0, 2), computed: cost(1.25, 2, 0) },
  compactions: 1,
  children: 1,
  ...patch,
});

const listBody = (): SessionList => ({
  period: { from, to },
  sessions: [item(), item({ id: CHILD, agent: "pi", cwd: null, branch: null, compactions: 0 })],
  truncated: false,
  pricing: { basis: "historical", observedAt: null },
});

const detailBody = (): SessionDetail => ({
  session: { ...item(), parentId: GRANDPARENT },
  turns: [
    {
      idx: 0,
      role: "user",
      ts: "2026-01-02T10:00:00.000Z",
      model: null,
      provider: null,
      effort: null,
      isCompaction: false,
      tokens: null,
      contextTokens: null,
      costs: { reported: null, computed: null },
      tools: [],
    },
    {
      idx: 1,
      role: "assistant",
      ts: "2026-01-02T10:01:00.000Z",
      model: "model-a",
      provider: "p",
      effort: "high",
      isCompaction: false,
      tokens: { input: 1000, output: 20, cacheRead: 3000, cacheWrite: 400 },
      contextTokens: 4400,
      costs: { reported: null, computed: 0.5 },
      tools: [
        { tool: "read", status: "ok", durationMs: 1500 },
        { tool: "edit", status: "error", durationMs: null },
      ],
    },
    {
      idx: 2,
      role: "compaction",
      ts: "2026-01-02T10:02:00.000Z",
      model: null,
      provider: null,
      effort: null,
      isCompaction: true,
      tokens: null,
      contextTokens: null,
      costs: { reported: null, computed: null },
      tools: [],
    },
    {
      idx: 3,
      role: "assistant",
      ts: "2026-01-02T10:03:00.000Z",
      model: "model-a",
      provider: "p",
      effort: "high",
      isCompaction: false,
      tokens: { input: 900, output: 10, cacheRead: 0, cacheWrite: 0 },
      contextTokens: 900,
      costs: { reported: null, computed: 0.75 },
      tools: [{ tool: "read", status: "ok", durationMs: 500 }],
    },
  ],
  parent: { id: GRANDPARENT, agent: "opencode" },
  children: [
    {
      id: CHILD,
      agent: "pi",
      startedAt: "2026-01-02T10:05:00.000Z",
      turns: 1,
      usageTurns: 1,
      tokens: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, total: 10 },
      costs: { reported: cost(null, 0, 1), computed: cost(null, 0, 1) },
    },
  ],
  pricing: { basis: "historical", observedAt: null },
  commits: [
    {
      repo: "repo-a",
      sha: "abc1234",
      subject: "feat: one",
      authoredAt: "2026-01-02T10:30:00.000Z",
      additions: 12,
      deletions: 2,
      tokens: 1_200_000,
    },
  ],
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fetcher = vi.fn<typeof fetch>();
let requests: string[];
let scheme: ReturnType<typeof fakeColorScheme>;

beforeEach(() => {
  window.history.replaceState(
    null,
    "",
    `/session?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
  requests = [];
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset();
  fetcher.mockImplementation(async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith("/api/sessions?")) return json(listBody());
    if (url === `/api/sessions/${PARENT}`) return json(detailBody());
    return json({ error: "session not found" }, 404);
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function view(language: "en" | "es" = "en") {
  const i18n = await createI18n({ storage: memoryStorage(), browserLanguages: [language] });
  scheme = fakeColorScheme(false);
  const utils = render(
    <I18nextProvider i18n={i18n}>
      <PreferencesProvider
        env={{
          storage: memoryStorage(),
          root: document.documentElement,
          matchMedia: scheme.matchMedia,
        }}
      >
        <SessionView />
      </PreferencesProvider>
    </I18nextProvider>,
  );
  return { i18n, ...utils };
}

const listTable = () => screen.findByRole("table", { name: en.session.list.title });

describe("Session list (S10, L21 UI: /session)", () => {
  it("requests the period only and lists sessions with tokens in M, costs and counts", async () => {
    await view();
    const table = await listTable();
    expect(requests).toEqual([
      `/api/sessions?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ]);
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    const first = rows[1] as HTMLElement;
    expect(within(first).getByText("Claude Code")).toBeTruthy();
    expect(within(first).getByText("project-x")).toBeTruthy();
    expect(within(first).getByText("main")).toBeTruthy();
    expect(within(first).getByText("1.5 M")).toBeTruthy();
    expect(within(first).getByText("$1.25")).toBeTruthy();
    const second = rows[2] as HTMLElement;
    expect(within(second).getByText("Pi")).toBeTruthy();
    expect(within(second).getAllByText(en.session.noValue)).toHaveLength(2);
  });

  it("filters by agent through the URL and refetches", async () => {
    await view();
    await listTable();
    const agents = screen.getByRole("radiogroup", { name: en.session.agent });
    fireEvent.click(within(agents).getByRole("radio", { name: "OpenCode" }));
    expect(new URLSearchParams(window.location.search).get("agent")).toBe("opencode");
    await waitFor(() => expect(requests.at(-1)).toContain("&agent=opencode"));
    fireEvent.click(within(agents).getByRole("radio", { name: en.session.allAgents }));
    expect(new URLSearchParams(window.location.search).has("agent")).toBe(false);
  });

  it("opens a session from its row, keeping the period in the URL", async () => {
    await view();
    const table = await listTable();
    fireEvent.click(within(table).getAllByRole("link")[0] as HTMLElement);
    const params = new URLSearchParams(window.location.search);
    expect(params.get("id")).toBe(PARENT);
    expect(params.get("from")).toBe(from);
    expect(await screen.findByRole("table", { name: en.session.turns.title })).toBeTruthy();
  });

  it("shows the empty state with the ingest command", async () => {
    fetcher.mockImplementation(async () => json({ ...listBody(), sessions: [] }));
    await view();
    expect(await screen.findByText(en.session.empty.title)).toBeTruthy();
    expect(screen.getByText(en.session.empty.command).tagName).toBe("CODE");
  });

  it("notes truncation", async () => {
    fetcher.mockImplementation(async () => json({ ...listBody(), truncated: true }));
    await view();
    await listTable();
    expect(screen.getByText(en.session.list.truncated)).toBeTruthy();
  });

  it("retries after an error", async () => {
    let calls = 0;
    fetcher.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return json({ error: "sessions unavailable" }, 500);
      return json(listBody());
    });
    await view();
    expect(await screen.findByText(en.session.list.error)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: en.common.retry }));
    expect(await listTable()).toBeTruthy();
  });
});

const openDetail = async (language: "en" | "es" = "en") => {
  window.history.replaceState(
    null,
    "",
    `/session?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&id=${PARENT}`,
  );
  const rendered = await view(language);
  await screen.findByRole("table", {
    name: (language === "en" ? en : es).session.turns.title,
  });
  return rendered;
};

describe("Session detail (S10, L21 UI: /session?id=…)", () => {
  it("fetches only the detail and shows the header with totals and costs", async () => {
    await openDetail();
    expect(requests).toEqual([`/api/sessions/${PARENT}`]);
    const overview = screen.getByRole("region", { name: en.session.detail.overview });
    expect(within(overview).getByText("Claude Code")).toBeTruthy();
    expect(within(overview).getByText("project-x")).toBeTruthy();
    expect(within(overview).getByText("main")).toBeTruthy();
    expect(within(overview).getByText("1.5 M")).toBeTruthy();
    expect(within(overview).getByText("$1.25")).toBeTruthy();
    expect(within(overview).getByText(en.summary.unknown)).toBeTruthy();
  });

  it("draws the context curve as an accessible image with the estimate note", async () => {
    await openDetail();
    const chart = screen.getByRole("img", { name: en.session.context.chartName });
    await waitFor(() => expect(chart.querySelector("svg")).not.toBeNull(), { timeout: 5000 });
    expect(screen.getByText(en.session.context.estimate)).toBeTruthy();
  });

  it("lists turns in order with context, tools and compaction markers", async () => {
    await openDetail();
    const table = screen.getByRole("table", { name: en.session.turns.title });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell")[0]?.textContent)).toEqual([
      "0",
      "1",
      "2",
      "3",
    ]);
    const second = rows[1] as HTMLElement;
    expect(within(second).getByText("4,400")).toBeTruthy();
    expect(within(second).getByText("model-a")).toBeTruthy();
    const calls = within(second).getByRole("list", { name: en.session.turns.tools });
    expect(
      within(calls)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["read", en.session.turns.toolError.replace("{{tool}}", "edit")]);
    expect(within(rows[2] as HTMLElement).getByText(en.session.role.compaction)).toBeTruthy();
    expect((rows[2] as HTMLElement).dataset.compaction).toBe("true");
  });

  it("summarizes tools: calls, errors and total duration", async () => {
    await openDetail();
    const table = screen.getByRole("table", { name: en.session.tools.title });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      `read20${en.session.seconds.replace("{{value}}", "2")}`,
      `edit11${en.session.noValue}`,
    ]);
  });

  it("links the parent and the children, and goes back to the list", async () => {
    await openDetail();
    const related = screen.getByRole("region", { name: en.session.related.title });
    const links = within(related).getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0]?.getAttribute("href")).toContain(`id=${encodeURIComponent(GRANDPARENT)}`);
    fireEvent.click(links[1] as HTMLElement);
    expect(new URLSearchParams(window.location.search).get("id")).toBe(CHILD);
    fireEvent.click(screen.getByRole("link", { name: en.session.back }));
    expect(new URLSearchParams(window.location.search).has("id")).toBe(false);
    expect(new URLSearchParams(window.location.search).get("from")).toBe(from);
    expect(await listTable()).toBeTruthy();
  });

  it("says when the parent was never ingested", async () => {
    fetcher.mockImplementation(async () =>
      json({ ...detailBody(), parent: { id: GRANDPARENT, agent: null }, children: [] }),
    );
    await openDetail();
    expect(screen.getByText(en.session.related.parentMissing)).toBeTruthy();
  });

  it("lists the associated commits with their line counts and tokens (T3, L20 item 2)", async () => {
    await openDetail();
    const commits = screen.getByRole("region", { name: en.session.commits.title });
    const table = within(commits).getByRole("table", { name: en.session.commits.title });
    const [row] = within(table).getAllByRole("row").slice(1) as [HTMLElement];
    expect(
      [...row.querySelectorAll("th, td")].map((cell) => cell.textContent?.replace(/\u00a0/g, " ")),
    ).toEqual([
      "repo-a",
      "abc1234",
      "feat: one",
      dateTimeFormat("en").format(new Date("2026-01-02T10:30:00.000Z")),
      "+12",
      "−2",
      "1.2 M",
    ]);
    expect(within(commits).getByText(en.session.commits.note)).toBeTruthy();
    expect(screen.queryByText(/phase 4/)).toBeNull();
  });

  it("says when no commit is associated", async () => {
    fetcher.mockImplementation(async () => json({ ...detailBody(), commits: [] }));
    await openDetail();
    const commits = screen.getByRole("region", { name: en.session.commits.title });
    expect(within(commits).getByText(en.session.commits.empty)).toBeTruthy();
    expect(within(commits).queryByRole("table")).toBeNull();
  });

  it("shows not found for unknown and malformed ids; malformed ones are never fetched", async () => {
    window.history.replaceState(null, "", `/session?id=${CHILD}`);
    await view();
    expect(await screen.findByText(en.session.notFound.title)).toBeTruthy();
    cleanup();
    requests = [];
    window.history.replaceState(null, "", "/session?id=nope");
    await view();
    expect(await screen.findByText(en.session.notFound.title)).toBeTruthy();
    expect(requests).toEqual([]);
  });

  it("retries a failed detail", async () => {
    let calls = 0;
    fetcher.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error("down");
      return json(detailBody());
    });
    window.history.replaceState(null, "", `/session?id=${PARENT}`);
    await view();
    expect(await screen.findByText(en.session.detail.error)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: en.common.retry }));
    expect(await screen.findByRole("table", { name: en.session.turns.title })).toBeTruthy();
  });
});

describe("Session hot switches (S11)", () => {
  it("switches language without refetching or changing the URL", async () => {
    const { i18n } = await openDetail();
    const search = window.location.search;
    const calls = requests.length;
    await act(async () => {
      await i18n.changeLanguage("es");
    });
    expect(window.location.search).toBe(search);
    expect(requests.length).toBe(calls);
    expect(screen.getByRole("table", { name: es.session.turns.title })).toBeTruthy();
    expect(screen.getByRole("img", { name: es.session.context.chartName })).toBeTruthy();
    expect(screen.getByText("1,5 M")).toBeTruthy();
  });

  it("switches theme without refetching or changing the URL", async () => {
    await openDetail();
    const search = window.location.search;
    const calls = requests.length;
    await act(async () => {
      scheme.setDark(true);
    });
    expect(window.location.search).toBe(search);
    expect(requests.length).toBe(calls);
    expect(screen.getByRole("img", { name: en.session.context.chartName })).toBeTruthy();
  });
});

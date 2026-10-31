// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitReport } from "../src/git/contract";
import { GitView } from "../src/git/GitView";
import en from "../src/i18n/en.json";
import es from "../src/i18n/es.json";
import { createI18n } from "../src/i18n/i18n";
import { PreferencesProvider } from "../src/prefs/usePreferences";
import { dateTimeFormat } from "../src/session/labels";
import { fakeColorScheme, memoryStorage } from "./helpers";

const from = "2026-01-01T00:00:00.000Z";
const to = "2026-01-08T00:00:00.000Z";
const GIT = `/api/git?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
const SESSION = `${"a".repeat(64)}:session:${"b".repeat(64)}`;

const answer = (patch: Partial<GitReport> = {}): GitReport => ({
  commits: [
    {
      repo: "repo-a",
      sha: "abc1234",
      subject: "feat: one",
      authoredAt: "2026-01-02T10:05:00.000Z",
      additions: 30,
      deletions: 10,
      tokens: 2_000_000,
      computedCostUsd: 4,
      reportedCostUsd: null,
      sessions: 1,
      pullRequest: null,
    },
    {
      repo: "repo-a",
      sha: "def5678",
      subject: "fix: two",
      authoredAt: "2026-01-03T11:00:00.000Z",
      additions: 1,
      deletions: 5,
      tokens: 500_000,
      computedCostUsd: null,
      reportedCostUsd: 1.5,
      sessions: 2,
      pullRequest: 7,
    },
  ],
  pullRequests: [
    {
      number: 7,
      repo: "repo-a",
      commits: 1,
      additions: 1,
      deletions: 5,
      tokens: 500_000,
      computedCostUsd: null,
      reportedCostUsd: 1.5,
    },
    {
      number: 9,
      repo: "repo-b",
      commits: 3,
      additions: 50,
      deletions: 10,
      tokens: 4_000_000,
      computedCostUsd: 2,
      reportedCostUsd: 3,
    },
  ],
  orphanSessions: [
    {
      sessionId: SESSION,
      agent: "claude-code",
      repo: "repo-a",
      startedAt: "2026-01-02T09:00:00.000Z",
      tokens: 1_500_000,
      computedCostUsd: 3,
      reportedCostUsd: null,
      hadCommit: true,
    },
    {
      sessionId: "s-2",
      agent: "pi",
      repo: null,
      startedAt: "2026-01-04T09:00:00.000Z",
      tokens: 500_000,
      computedCostUsd: null,
      reportedCostUsd: null,
      hadCommit: false,
    },
  ],
  ...patch,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fetcher = vi.fn<typeof fetch>();
let requests: string[] = [];
let body: () => Response | Promise<Response>;

beforeEach(() => {
  window.history.replaceState(
    null,
    "",
    `/git?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
  requests = [];
  body = () => json(answer());
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset();
  fetcher.mockImplementation(async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith("/api/git?")) return body();
    return json({ error: "not found" }, 404);
  });
});
afterEach(() => {
  cleanup();
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
        <GitView />
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

describe("Git view (T3, S4, L20 item 1)", () => {
  it("requests the period's report only", async () => {
    await view();
    await region(en.git.commits.title);
    expect(requests).toEqual([GIT]);
    expect(screen.getByRole("heading", { level: 1, name: en.git.title })).toBeTruthy();
  });

  it("shows the attributed and orphan token totals of the period", async () => {
    await view();
    const headline = await screen.findByText(
      en.git.headline.replace("{{attributed}}", "2.5 M").replace("{{orphan}}", "2.0 M"),
    );
    expect(headline).toBeTruthy();
  });

  it("lists commits with lines, tokens, costs, sessions, PR and tokens per net line", async () => {
    await view();
    const commits = await region(en.git.commits.title);
    const [one, two] = rows(commits, en.git.commits.title) as [HTMLElement, HTMLElement];
    const date = dateTimeFormat("en");
    expect(cells(one)).toEqual([
      "repo-a",
      "abc1234",
      "feat: one",
      date.format(new Date("2026-01-02T10:05:00.000Z")),
      "+30",
      "−10",
      "2.0 M",
      "$4.00",
      en.git.noCost,
      "1",
      en.git.noPullRequest,
      "100,000",
    ]);
    // Net lines 1 − 5 ≤ 0: tokens per net line do not apply.
    expect(cells(two).slice(6)).toEqual([
      "0.5 M",
      en.git.noCost,
      "$1.50",
      "2",
      "#7",
      en.git.notApplicable,
    ]);
    expect(one.querySelector("code")?.textContent).toBe("abc1234");
  });

  it("lists pull requests with their figures and tokens per net line", async () => {
    await view();
    const prs = await region(en.git.pullRequests.title);
    const [seven, nine] = rows(prs, en.git.pullRequests.title) as [HTMLElement, HTMLElement];
    expect(cells(seven)).toEqual([
      "#7",
      "repo-a",
      "1",
      "+1",
      "−5",
      "0.5 M",
      en.git.noCost,
      "$1.50",
      en.git.notApplicable,
    ]);
    expect(cells(nine)).toEqual([
      "#9",
      "repo-b",
      "3",
      "+50",
      "−10",
      "4.0 M",
      "$2.00",
      "$3.00",
      "100,000",
    ]);
  });

  it("lists orphan sessions with a link to the session, the repository or none, and had commits", async () => {
    await view();
    const orphans = await region(en.git.orphans.title);
    const [first, second] = rows(orphans, en.git.orphans.title) as [HTMLElement, HTMLElement];
    const date = dateTimeFormat("en");
    expect(cells(first)).toEqual([
      date.format(new Date("2026-01-02T09:00:00.000Z")),
      en.session.agentName.claudeCode,
      "repo-a",
      "1.5 M",
      "$3.00",
      en.git.noCost,
      en.git.yes,
    ]);
    expect(cells(second).slice(1, 3)).toEqual([
      en.session.agentName.pi,
      en.git.orphans.noRepository,
    ]);
    expect(cells(second).at(-1)).toBe(en.git.no);
    const link = within(first).getByRole("link");
    fireEvent.click(link);
    expect(window.location.pathname).toBe("/session");
    const params = new URLSearchParams(window.location.search);
    expect(params.get("id")).toBe(SESSION);
    expect(params.get("from")).toBe(from);
  });

  it("draws tokens per commit over time as an accessible chart", async () => {
    await view();
    const timeline = await region(en.git.timeline.title);
    expect(
      await within(timeline).findByRole("img", { name: en.git.timeline.chartName }),
    ).toBeTruthy();
  });

  it("says when a section has nothing in the period", async () => {
    body = () => json(answer({ pullRequests: [], orphanSessions: [] }));
    await view();
    const prs = await region(en.git.pullRequests.title);
    expect(within(prs).getByText(en.git.pullRequests.empty)).toBeTruthy();
    const orphans = await region(en.git.orphans.title);
    expect(within(orphans).getByText(en.git.orphans.empty)).toBeTruthy();
  });

  it("invites to ingest when the period has no commits and no orphan sessions", async () => {
    body = () => json(answer({ commits: [], pullRequests: [], orphanSessions: [] }));
    await view();
    expect(await screen.findByText(en.git.empty.title)).toBeTruthy();
    expect(screen.getByText("pnpm omt ingest").tagName).toBe("CODE");
    expect(screen.queryByRole("region", { name: en.git.commits.title })).toBeNull();
  });

  it("shows a loading state until the report arrives", async () => {
    body = () => new Promise<Response>(() => {});
    await view();
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByText(en.common.loading)).toBeTruthy();
  });

  it("explains a failure and retries", async () => {
    body = () => json({ error: "git unavailable" }, 500);
    await view();
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(en.git.error)).toBeTruthy();
    body = () => json(answer());
    fireEvent.click(within(alert).getByRole("button", { name: en.common.retry }));
    expect(await region(en.git.commits.title)).toBeTruthy();
  });

  it("changes the period through the URL", async () => {
    await view();
    await region(en.git.commits.title);
    fireEvent.click(screen.getByRole("radio", { name: en.summary.last30Days }));
    const params = new URLSearchParams(window.location.search);
    expect(Date.parse(params.get("to") ?? "") - Date.parse(params.get("from") ?? "")).toBe(
      30 * 86_400_000,
    );
    expect(requests.at(-1)).toContain("/api/git?from=");
    expect(requests.at(-1)).not.toBe(GIT);
  });

  it("switches language hot, keeping the data without refetching", async () => {
    const i18n = await view();
    await region(en.git.commits.title);
    const before = requests.length;
    await act(async () => {
      await i18n.changeLanguage("es");
    });
    expect(screen.getByRole("heading", { level: 1, name: es.git.title })).toBeTruthy();
    const commits = await region(es.git.commits.title);
    const [one] = rows(commits, es.git.commits.title) as [HTMLElement];
    expect(cells(one)).toContain("100.000");
    expect(cells(one)).toContain("2,0 M");
    expect(requests.length).toBe(before);
  });
});

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../src/i18n/en.json";
import es from "../src/i18n/es.json";
import { createI18n } from "../src/i18n/i18n";
import { PreferencesProvider } from "../src/prefs/usePreferences";
import type { ProfileFigures, ProfileReport, Profiles } from "../src/profiles/contract";
import { dateTimeFormat } from "../src/session/labels";
import { ProfilesView } from "../src/views/ProfilesView";
import { fakeColorScheme, memoryStorage } from "./helpers";

const from = "2026-01-01T00:00:00.000Z";
const to = "2026-01-08T00:00:00.000Z";
const PROFILES = `/api/profiles?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

const figures = (patch: Partial<ProfileFigures> = {}): ProfileFigures => ({
  turns: 10,
  sessions: 2,
  input: 1_000_000,
  output: 500_000,
  cacheRead: 400_000,
  cacheWrite: 100_000,
  total: 2_000_000,
  computedCost: 8,
  reportedCost: null,
  exactTurns: 10,
  estimatedTurns: 0,
  exactShare: 1,
  estimatedShare: 0,
  ...patch,
});

const estimatedOnly = { exactTurns: 0, estimatedTurns: 4, exactShare: 0, estimatedShare: 1 };

const deep = (): ProfileReport => ({
  name: "deep",
  versions: [
    { hash: "aaaaaaaaaaaa1111111111", firstSeenAt: "2026-01-02T08:00:00.000Z" },
    { hash: "bbbbbbbbbbbb2222222222", firstSeenAt: "2026-01-05T09:30:00.000Z" },
  ],
  totals: figures({ exactTurns: 6, estimatedTurns: 4, exactShare: 0.6, estimatedShare: 0.4 }),
  sessions: [
    {
      sessionId: "s-1",
      agent: "gentle-shell",
      startedAt: "2026-01-03T10:00:00.000Z",
      ...figures({ sessions: 1, total: 1_500_000, computedCost: 6 }),
    },
    {
      sessionId: "s-2",
      agent: "gentle-shell",
      startedAt: "2026-01-06T10:00:00.000Z",
      ...figures({ sessions: 1, total: 500_000, computedCost: 2, ...estimatedOnly }),
    },
  ],
  roles: [
    { role: "review-risk", ...figures({ total: 200_000, computedCost: 1, ...estimatedOnly }) },
    { role: "orchestrator", ...figures({ total: 1_200_000, computedCost: 5 }) },
    { role: "gentle-ai-worker", ...figures({ total: 400_000, computedCost: 1.5 }) },
    { role: "unknown", ...figures({ total: 200_000, computedCost: 0.5 }) },
  ],
  efforts: [
    {
      provider: "anthropic",
      model: "claude-opus",
      effort: "high",
      ...figures({ total: 1_600_000, computedCost: 7 }),
    },
    {
      provider: "anthropic",
      model: "claude-opus",
      effort: "low",
      ...figures({ total: 400_000, computedCost: 1 }),
    },
  ],
  subscriptions: [
    {
      subscriptionId: "claude-pro",
      label: "Claude Pro",
      ...figures({ total: 1_500_000, computedCost: 6 }),
    },
    { subscriptionId: null, label: null, ...figures({ total: 500_000, computedCost: 2 }) },
  ],
});

const quick = (): ProfileReport => ({
  name: "quick",
  versions: [{ hash: "cccccccccccc3333333333", firstSeenAt: "2026-01-01T00:00:00.000Z" }],
  totals: figures({ total: 600_000, computedCost: 1.2, sessions: 3, ...estimatedOnly }),
  sessions: [],
  roles: [],
  efforts: [],
  subscriptions: [],
});

const answer = (patch: Partial<Profiles> = {}): Profiles => ({
  period: { from, to },
  profiles: [deep(), quick()],
  unattributed: figures({
    turns: 3,
    sessions: 1,
    total: 300_000,
    computedCost: 0.9,
    exactTurns: 0,
    exactShare: null,
    estimatedShare: null,
  }),
  ...patch,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fetcher = vi.fn<typeof fetch>();
let requests: string[] = [];
let body: () => Response;

beforeEach(() => {
  window.history.replaceState(
    null,
    "",
    `/profiles?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
  requests = [];
  body = () => json(answer());
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset();
  fetcher.mockImplementation(async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith("/api/profiles?")) return body();
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
        <ProfilesView />
      </PreferencesProvider>
    </I18nextProvider>,
  );
  return i18n;
}

const region = (name: string) => screen.findByRole("region", { name });
const table = (scope: HTMLElement, name: string) => within(scope).getByRole("table", { name });
const rows = (scope: HTMLElement) => within(scope).getAllByRole("row").slice(1);
/** The figure is inside an element marked as estimated that shows the visible tag (spec §6.2). */
function expectEstimated(scope: HTMLElement, text: string) {
  const matches = within(scope).getAllByText(text);
  for (const node of matches) {
    const marked = node.closest('[data-estimated="true"]');
    expect(marked, text).not.toBeNull();
    expect(marked?.textContent).toContain(en.quota.estimated);
  }
}

describe("Profiles (S7, S9)", () => {
  it("requests the period's profiles only", async () => {
    await view();
    await region("deep");
    expect(requests).toEqual([PROFILES]);
  });

  it("compares profiles by cost and tokens, total and per session", async () => {
    await view();
    const comparison = await region(en.profiles.comparison.title);
    const compared = table(comparison, en.profiles.comparison.table);
    const [deepRow, quickRow] = rows(compared) as [HTMLElement, HTMLElement];
    expect(within(deepRow).getByText("deep")).toBeTruthy();
    expect(within(deepRow).getByText("2.0 M")).toBeTruthy();
    expect(within(deepRow).getByText("1.0 M")).toBeTruthy();
    expect(within(deepRow).getByText("$8.00")).toBeTruthy();
    expect(within(deepRow).getByText("$4.00")).toBeTruthy();
    expect(within(quickRow).getByText("$1.20")).toBeTruthy();
    expect(within(quickRow).getByText("$0.40")).toBeTruthy();
    expect(
      await within(comparison).findByRole("img", { name: en.profiles.comparison.chartName }),
    ).toBeTruthy();
  });

  it("marks estimated attribution and keeps the exact share apart", async () => {
    await view();
    const comparison = await region(en.profiles.comparison.title);
    const [deepRow, quickRow] = rows(table(comparison, en.profiles.comparison.table)) as [
      HTMLElement,
      HTMLElement,
    ];
    expect(within(deepRow).getByText("60.0% exact")).toBeTruthy();
    expect(within(deepRow).getByText("60.0% exact").closest("[data-estimated]")).toBeNull();
    expectEstimated(deepRow, "40.0%");
    expectEstimated(quickRow, "100.0%");
    expect(within(quickRow).queryByText(/exact/)).toBeNull();
  });

  it("breaks each profile down by role in the spec order, with the stored agent name", async () => {
    await view();
    const deepRegion = await region("deep");
    const roles = rows(table(deepRegion, en.profiles.roles.title));
    expect(roles.map((row) => (row as HTMLTableRowElement).cells[0]?.textContent)).toEqual([
      en.profiles.roles.category.orchestrator,
      en.profiles.roles.category.writer,
      en.profiles.roles.category.reviewer,
      en.profiles.roles.category.unknown,
    ]);
    expect(within(roles[1] as HTMLElement).getByText("gentle-ai-worker")).toBeTruthy();
    expect(within(roles[0] as HTMLElement).getByText("$5.00")).toBeTruthy();
    expectEstimated(roles[2] as HTMLElement, "100.0%");
  });

  it("shows effort as its own dimension: same model, different effort", async () => {
    await view();
    const deepRegion = await region("deep");
    const efforts = table(deepRegion, en.profiles.efforts.title);
    const [high, low] = rows(efforts) as [HTMLElement, HTMLElement];
    expect(within(high).getByText("anthropic/claude-opus")).toBeTruthy();
    expect(within(high).getByText("high")).toBeTruthy();
    expect(within(low).getByText("low")).toBeTruthy();
    expect(within(low).getByText("$1.00")).toBeTruthy();
    expect(within(efforts).getByText(en.profiles.efforts.compared)).toBeTruthy();
  });

  it("lists the subscriptions each profile drains, pay-as-you-go included", async () => {
    await view();
    const deepRegion = await region("deep");
    const subscriptions = rows(table(deepRegion, en.profiles.subscriptions.title));
    expect(within(subscriptions[0] as HTMLElement).getByText("Claude Pro")).toBeTruthy();
    expect(within(subscriptions[0] as HTMLElement).getByText("$6.00")).toBeTruthy();
    expect(
      within(subscriptions[1] as HTMLElement).getByText(en.profiles.subscriptions.payAsYouGo),
    ).toBeTruthy();
  });

  it("lists the snapshot versions used and the sessions", async () => {
    await view();
    const format = dateTimeFormat("en");
    const deepRegion = await region("deep");
    const versions = within(deepRegion).getByRole("list", { name: en.profiles.versions.title });
    const items = within(versions).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0] as HTMLElement).getByText("aaaaaaaaaaaa").tagName).toBe("CODE");
    expect(items[1]?.textContent).toContain(format.format(new Date("2026-01-05T09:30:00.000Z")));
    const sessions = rows(table(deepRegion, en.profiles.sessions.title));
    expect(sessions).toHaveLength(2);
    const link = within(sessions[0] as HTMLElement).getByRole("link");
    expect(link.getAttribute("href")).toContain("id=s-1");
    expectEstimated(sessions[1] as HTMLElement, "100.0%");
  });

  it("shows the unattributed gentle-shell turns", async () => {
    await view();
    const unattributed = await region(en.profiles.unattributed.title);
    expect(within(unattributed).getByText("3")).toBeTruthy();
    expect(within(unattributed).getByText("0.3 M")).toBeTruthy();
    expect(within(unattributed).getByText("$0.90")).toBeTruthy();
  });

  it("says when every gentle-shell turn was attributed", async () => {
    body = () => json(answer({ unattributed: figures({ turns: 0, sessions: 0, total: 0 }) }));
    await view();
    const unattributed = await region(en.profiles.unattributed.title);
    expect(within(unattributed).getByText(en.profiles.unattributed.none)).toBeTruthy();
  });

  it("invites to ingest when the period has no gentle-shell turns", async () => {
    body = () =>
      json(
        answer({
          profiles: [],
          unattributed: figures({ turns: 0, sessions: 0, total: 0, computedCost: null }),
        }),
      );
    await view();
    expect(await screen.findByText(en.profiles.empty.title)).toBeTruthy();
    expect(screen.getByText("pnpm omt ingest").tagName).toBe("CODE");
    expect(screen.queryByRole("region", { name: en.profiles.comparison.title })).toBeNull();
  });

  it("says no profile matched when there are only unattributed turns", async () => {
    body = () => json(answer({ profiles: [] }));
    await view();
    expect(await screen.findByText(en.profiles.noProfiles.title)).toBeTruthy();
    expect(await region(en.profiles.unattributed.title)).toBeTruthy();
  });

  it("explains a failure and retries", async () => {
    body = () => json({ error: "profiles unavailable" }, 500);
    await view();
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(en.profiles.error)).toBeTruthy();
    body = () => json(answer());
    fireEvent.click(within(alert).getByRole("button", { name: en.common.retry }));
    expect(await region("deep")).toBeTruthy();
  });

  it("changes the period through the URL", async () => {
    await view();
    await region("deep");
    fireEvent.click(screen.getByRole("radio", { name: en.summary.last30Days }));
    const params = new URLSearchParams(window.location.search);
    expect(Date.parse(params.get("to") ?? "") - Date.parse(params.get("from") ?? "")).toBe(
      30 * 86_400_000,
    );
    expect(requests.at(-1)).toContain("/api/profiles?from=");
    expect(requests.at(-1)).not.toBe(PROFILES);
  });

  it("switches language hot without refetching", async () => {
    const i18n = await view();
    await region("deep");
    const before = requests.length;
    await act(async () => {
      await i18n.changeLanguage("es");
    });
    expect(screen.getByRole("heading", { level: 1, name: es.profiles.title })).toBeTruthy();
    const comparison = await region(es.profiles.comparison.title);
    expect(within(comparison).getByText("60,0 % exacto")).toBeTruthy();
    expect(requests.length).toBe(before);
  });
});

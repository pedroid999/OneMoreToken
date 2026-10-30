// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../src/i18n/en.json";
import es from "../src/i18n/es.json";
import { createI18n } from "../src/i18n/i18n";
import { PreferencesProvider } from "../src/prefs/usePreferences";
import type {
  CalibrationEntry,
  QuotaSubscriptionReport,
  Quotas,
  QuotaWindow,
  QuotaWindowKindReport,
} from "../src/quotas/contract";
import { quotaTimeFormat, toLocalInput } from "../src/quotas/state";
import { BurnRateView } from "../src/views/BurnRateView";
import { fakeColorScheme, memoryStorage } from "./helpers";

const from = "2026-01-01T00:00:00.000Z";
const to = "2026-01-08T00:00:00.000Z";
const QUOTAS = `/api/quotas?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

const win = (
  startsAt: string,
  endsAt: string,
  pct: number | null,
  over: number | null = 0,
): QuotaWindow => ({
  startsAt,
  endsAt,
  usedUsd: 3,
  usedTokens: 1000,
  limitUsd: pct === null ? null : 12,
  limitTokens: null,
  estimatedPct: pct,
  overLimitUsd: over,
  limitSource: pct === null ? "unknown" : "plan",
  estimated: true,
});

const kind = (patch: Partial<QuotaWindowKindReport>): QuotaWindowKindReport => ({
  kind: "five_hours",
  unit: "usd",
  limitSource: "plan",
  limitUsd: 12,
  limitTokens: null,
  windows: [],
  current: null,
  resetsAt: null,
  projection: null,
  overLimitUsd: 0,
  calibration: { readings: [], meanAbsoluteDeviationPct: null },
  ...patch,
});

const reading = (
  id: string,
  observedAt: string,
  observedPct: number,
  predictedPct: number | null,
) => ({
  id,
  observedAt,
  observedPct,
  usedUsd: 2,
  usedTokens: 100,
  predictedPct,
  deltaPct: predictedPct === null ? null : predictedPct - observedPct,
});

const claudeCurrent = win("2026-01-07T20:00:00.000Z", "2026-01-08T01:00:00.000Z", 42.5);
const claude = (): QuotaSubscriptionReport => ({
  id: "claude-pro",
  planId: "claude-pro",
  label: "Claude Pro",
  provider: "anthropic",
  startedAt: null,
  endedAt: null,
  monthlyPriceUsd: 20,
  windows: [
    kind({
      unit: "estimated",
      limitSource: "calibrated",
      windows: [win("2026-01-07T10:00:00.000Z", "2026-01-07T15:00:00.000Z", 80), claudeCurrent],
      current: claudeCurrent,
      resetsAt: claudeCurrent.endsAt,
      projection: { projectedLimitAt: "2026-01-07T23:30:00.000Z", reached: false, estimated: true },
      calibration: {
        readings: [
          reading("r1", "2026-01-07T12:00:00.000Z", 40, 41),
          reading("r2", "2026-01-07T21:00:00.000Z", 30, 28),
        ],
        meanAbsoluteDeviationPct: 1.5,
      },
    }),
    kind({
      kind: "weekly",
      unit: "estimated",
      limitSource: "calibrated",
      windows: [win("2026-01-05T00:00:00.000Z", "2026-01-12T00:00:00.000Z", 20)],
      current: win("2026-01-05T00:00:00.000Z", "2026-01-12T00:00:00.000Z", 20),
      resetsAt: "2026-01-12T00:00:00.000Z",
      projection: { projectedLimitAt: null, reached: false, estimated: true },
      calibration: {
        readings: [reading("r3", "2026-01-06T09:00:00.000Z", 15, null)],
        meanAbsoluteDeviationPct: null,
      },
    }),
  ],
  extractedValue: { apiEquivalentUsd: 30, unpricedTurns: 2, paidUsd: 4.6, ratio: 6.52 },
});

const overWindow = win("2026-01-03T00:00:00.000Z", "2026-01-03T05:00:00.000Z", 120, 2.4);
const opencode = (): QuotaSubscriptionReport => ({
  id: "opencode-go",
  planId: "opencode-go",
  label: "OpenCode Go",
  provider: "opencode",
  startedAt: "2025-12-15T00:00:00.000Z",
  endedAt: null,
  monthlyPriceUsd: null,
  windows: [
    kind({ windows: [overWindow], overLimitUsd: 2.4 }),
    kind({
      kind: "weekly",
      limitUsd: 30,
      windows: [win("2026-01-02T00:00:00.000Z", "2026-01-09T00:00:00.000Z", 100)],
      current: win("2026-01-02T00:00:00.000Z", "2026-01-09T00:00:00.000Z", 100),
      resetsAt: "2026-01-09T00:00:00.000Z",
      projection: { projectedLimitAt: null, reached: true, estimated: true },
    }),
    kind({
      kind: "monthly",
      limitUsd: 60,
      windows: [win("2025-12-15T00:00:00.000Z", "2026-01-15T00:00:00.000Z", 55)],
      current: win("2025-12-15T00:00:00.000Z", "2026-01-15T00:00:00.000Z", 55),
      resetsAt: "2026-01-15T00:00:00.000Z",
      projection: { projectedLimitAt: null, reached: false, estimated: true },
    }),
  ],
  extractedValue: { apiEquivalentUsd: 15, unpricedTurns: 0, paidUsd: null, ratio: null },
});

const quotas = (patch: Partial<Quotas> = {}): Quotas => ({
  config: { status: "ok" },
  calibrations: { status: "ok" },
  subscriptions: [claude(), opencode()],
  ...patch,
});

const entries = (): CalibrationEntry[] => [
  {
    id: "r1",
    subscriptionId: "claude-pro",
    windowKind: "five_hours",
    observedAt: "2026-01-07T12:00:00.000Z",
    observedPct: 40,
    note: "console reading",
  },
  {
    id: "r2",
    subscriptionId: "claude-pro",
    windowKind: "five_hours",
    observedAt: "2026-01-07T21:00:00.000Z",
    observedPct: 30,
  },
  {
    id: "r3",
    subscriptionId: "claude-pro",
    windowKind: "weekly",
    observedAt: "2026-01-06T09:00:00.000Z",
    observedPct: 15,
  },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fetcher = vi.fn<typeof fetch>();
let requests: Array<{ url: string; method: string; body?: string; type?: string | null }> = [];
let quotasBody: () => Response;
let calibrationsBody: () => Response;
let postResponse: () => Response;

beforeEach(() => {
  window.history.replaceState(
    null,
    "",
    `/burn-rate?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
  requests = [];
  quotasBody = () => json(quotas());
  calibrationsBody = () => json({ calibrations: entries() });
  postResponse = () => json({ id: "new", ...entries()[0] }, 201);
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset();
  fetcher.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({
      url,
      method,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
      type: new Headers(init?.headers).get("content-type"),
    });
    if (url.startsWith("/api/quotas?")) return quotasBody();
    if (url === "/api/calibrations" && method === "GET") return calibrationsBody();
    if (url === "/api/calibrations" && method === "POST") return postResponse();
    if (url.startsWith("/api/calibrations/") && method === "DELETE")
      return new Response(null, { status: 204 });
    return json({ error: "not found" }, 404);
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
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
        <BurnRateView />
      </PreferencesProvider>
    </I18nextProvider>,
  );
  return i18n;
}

const region = (name: string) => screen.findByRole("region", { name });
const gets = () => requests.filter((r) => r.method === "GET").map((r) => r.url);
/** The figure is inside an element marked as estimated that shows the visible tag (S4). */
function expectEstimated(scope: HTMLElement, text: string) {
  const matches = within(scope).getAllByText(text);
  for (const node of matches) {
    const marked = node.closest('[data-estimated="true"]');
    expect(marked, text).not.toBeNull();
    expect(marked?.textContent).toContain(en.quota.estimated);
  }
}

describe("Burn rate (S3, S4, S9)", () => {
  it("requests the period's quotas and the calibrations only", async () => {
    await view();
    await region("Claude Pro");
    expect(gets().sort()).toEqual(["/api/calibrations", QUOTAS]);
  });

  it("shows the 5-hour timeline with every window figure marked as estimated", async () => {
    await view();
    const claudeRegion = await region("Claude Pro");
    const timeline = within(claudeRegion).getByRole("table", { name: en.burnRate.timeline.title });
    const rows = within(timeline).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expectEstimated(timeline, "80.0%");
    expectEstimated(timeline, "42.5%");
    expect(rows[1]?.getAttribute("data-level")).toBe("warn");
    expect(rows[2]?.getAttribute("data-level")).toBe("ok");
    const opencodeRegion = await region("OpenCode Go");
    const over = within(opencodeRegion).getByRole("table", { name: en.burnRate.timeline.title });
    expect(within(over).getAllByRole("row")[1]?.getAttribute("data-level")).toBe("over");
    expectEstimated(over, "120.0%");
  });

  it("shows weekly and monthly gauges with their reset date, and the pace projection", async () => {
    await view();
    const format = quotaTimeFormat("en");
    const claudeRegion = await region("Claude Pro");
    const weekly = within(claudeRegion).getByRole("meter", { name: en.quota.window.weekly });
    expect(weekly.getAttribute("value")).toBe("20");
    expectEstimated(claudeRegion, "20.0%");
    expect(
      within(claudeRegion).getByText(
        `Resets ${format.format(new Date("2026-01-12T00:00:00.000Z"))}`,
        { exact: false },
      ),
    ).toBeTruthy();
    // Current 5 h window: projected time; weekly: not before reset.
    const projected = within(claudeRegion).getByText(
      `Limit reached around ${format.format(new Date("2026-01-07T23:30:00.000Z"))} at the current pace`,
    );
    expect(projected.closest('[data-estimated="true"]')).not.toBeNull();
    expect(within(claudeRegion).getByText(en.burnRate.pace.notBeforeReset)).toBeTruthy();

    const opencodeRegion = await region("OpenCode Go");
    expect(
      within(opencodeRegion).getByRole("meter", { name: en.quota.window.monthly }),
    ).toBeTruthy();
    expect(
      within(opencodeRegion).getByText(
        `Resets ${format.format(new Date("2026-01-15T00:00:00.000Z"))}`,
        { exact: false },
      ),
    ).toBeTruthy();
    expect(within(opencodeRegion).getByText(en.burnRate.pace.reached)).toBeTruthy();
    expect(within(opencodeRegion).getByText(en.burnRate.pace.unavailable)).toBeTruthy();
  });

  it("shows the extracted value with unpriced turns, and an unknown price", async () => {
    await view();
    const claudeRegion = await region("Claude Pro");
    const value = within(claudeRegion).getByRole("region", { name: en.burnRate.value.title });
    expect(within(value).getByText("$30.00")).toBeTruthy();
    expect(within(value).getByText("$4.60")).toBeTruthy();
    expect(within(value).getByText("6.52× what you pay")).toBeTruthy();
    expect(within(value).getByText("2 turns without a price are not counted")).toBeTruthy();
    const opencodeRegion = await region("OpenCode Go");
    const other = within(opencodeRegion).getByRole("region", { name: en.burnRate.value.title });
    expect(within(other).getByText(en.burnRate.value.priceUnknown)).toBeTruthy();
    expect(within(other).queryByText(/without a price/)).toBeNull();
  });

  it("lists usage over the limit, or says there is none", async () => {
    await view();
    const opencodeRegion = await region("OpenCode Go");
    const list = within(opencodeRegion).getByRole("table", { name: en.burnRate.overLimit.title });
    const rows = within(list).getAllByRole("row");
    expect(rows).toHaveLength(2);
    expect(within(rows[1] as HTMLElement).getByText(en.quota.window.fiveHours)).toBeTruthy();
    expectEstimated(list, "$2.40");
    const claudeRegion = await region("Claude Pro");
    expect(within(claudeRegion).getByText(en.burnRate.overLimit.empty)).toBeTruthy();
  });

  it("shows readings with predicted %, delta and the mean absolute deviation, or the 2-reading state", async () => {
    await view();
    const claudeRegion = await region("Claude Pro");
    const calibration = within(claudeRegion).getByRole("region", {
      name: en.burnRate.calibration.title,
    });
    const table = within(calibration).getByRole("table", { name: en.burnRate.readings.title });
    const rows = within(table).getAllByRole("row");
    // Newest first: r2, r1, r3.
    expect(rows).toHaveLength(4);
    expect(within(rows[2] as HTMLElement).getByText("console reading")).toBeTruthy();
    expectEstimated(table, "41.0%");
    expectEstimated(table, "+1.0 pp");
    expectEstimated(table, "-2.0 pp");
    const deviation = within(calibration).getByText(
      "5-hour window: mean absolute deviation 1.5 pp",
    );
    expect(deviation.closest('[data-estimated="true"]')).not.toBeNull();
    expect(
      within(calibration).getByText(`weekly window: ${en.burnRate.deviation.needsMore}`),
    ).toBeTruthy();
  });

  it("limits the calibration form to the plan's windows and defaults the time to now", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = new Date(2026, 0, 7, 22, 15).getTime();
    vi.setSystemTime(now);
    await view();
    const claudeRegion = await region("Claude Pro");
    const select = within(claudeRegion).getByRole("combobox", {
      name: en.burnRate.calibration.windowKind,
    });
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.getAttribute("value")),
    ).toEqual(["five_hours", "weekly"]);
    const time = within(claudeRegion).getByLabelText(
      en.burnRate.calibration.observedAt,
    ) as HTMLInputElement;
    expect(time.value).toBe(toLocalInput(now));
    const opencodeRegion = await region("OpenCode Go");
    const other = within(opencodeRegion).getByRole("combobox", {
      name: en.burnRate.calibration.windowKind,
    });
    expect(within(other).getAllByRole("option")).toHaveLength(3);
  });

  it("validates before posting and keeps the stored data untouched on invalid input", async () => {
    await view();
    const claudeRegion = await region("Claude Pro");
    const form = within(claudeRegion).getByRole("form", { name: en.burnRate.calibration.title });
    fireEvent.change(within(form).getByLabelText(en.burnRate.calibration.observedPct), {
      target: { value: "150" },
    });
    fireEvent.click(within(form).getByRole("button", { name: en.burnRate.calibration.submit }));
    expect(within(form).getByText(en.burnRate.calibration.errors.observedPct)).toBeTruthy();
    expect(
      within(form).getByLabelText(en.burnRate.calibration.observedPct).getAttribute("aria-invalid"),
    ).toBe("true");
    expect(requests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  it("posts a valid reading as JSON, refetches quotas and readings, and confirms", async () => {
    await view();
    const claudeRegion = await region("Claude Pro");
    const form = within(claudeRegion).getByRole("form", { name: en.burnRate.calibration.title });
    fireEvent.change(within(form).getByRole("combobox"), { target: { value: "weekly" } });
    fireEvent.change(within(form).getByLabelText(en.burnRate.calibration.observedPct), {
      target: { value: "33.5" },
    });
    fireEvent.change(within(form).getByLabelText(en.burnRate.calibration.observedAt), {
      target: { value: "2026-01-07T21:30" },
    });
    fireEvent.change(within(form).getByLabelText(en.burnRate.calibration.note), {
      target: { value: " from console " },
    });
    const before = gets().length;
    fireEvent.click(within(form).getByRole("button", { name: en.burnRate.calibration.submit }));
    expect(await within(claudeRegion).findByText(en.burnRate.calibration.saved)).toBeTruthy();
    const post = requests.find((r) => r.method === "POST");
    expect(post?.url).toBe("/api/calibrations");
    expect(post?.type).toBe("application/json");
    expect(JSON.parse(post?.body ?? "")).toEqual({
      subscriptionId: "claude-pro",
      windowKind: "weekly",
      observedAt: new Date(2026, 0, 7, 21, 30).toISOString(),
      observedPct: 33.5,
      note: "from console",
    });
    await waitFor(() => expect(gets().length).toBe(before + 2));
    expect(gets().slice(before).sort()).toEqual(["/api/calibrations", QUOTAS]);
    // The view stays mounted while refreshing.
    expect(screen.getByRole("region", { name: "Claude Pro" })).toBeTruthy();
  });

  it("explains a rejected or unsafe save without clearing the draft", async () => {
    postResponse = () => json({ error: "unsafe calibration storage" }, 409);
    await view();
    const claudeRegion = await region("Claude Pro");
    const form = within(claudeRegion).getByRole("form", { name: en.burnRate.calibration.title });
    const pct = within(form).getByLabelText(
      en.burnRate.calibration.observedPct,
    ) as HTMLInputElement;
    fireEvent.change(pct, { target: { value: "10" } });
    fireEvent.click(within(form).getByRole("button", { name: en.burnRate.calibration.submit }));
    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toContain(
      en.burnRate.calibration.errors.storage.split("{{")[0] ?? "",
    );
    expect(pct.value).toBe("10");
    postResponse = () => json({ error: "invalid calibration" }, 400);
    fireEvent.click(within(form).getByRole("button", { name: en.burnRate.calibration.submit }));
    expect(await within(form).findByText(en.burnRate.calibration.errors.rejected)).toBeTruthy();
  });

  it("deletes a reading and refetches", async () => {
    await view();
    const claudeRegion = await region("Claude Pro");
    const table = within(claudeRegion).getByRole("table", { name: en.burnRate.readings.title });
    const before = gets().length;
    fireEvent.click(
      within(table).getAllByRole("button", { name: /^Delete the/ })[0] as HTMLElement,
    );
    await waitFor(() => expect(requests.some((r) => r.method === "DELETE")).toBe(true));
    expect(requests.find((r) => r.method === "DELETE")?.url).toBe("/api/calibrations/r2");
    await waitFor(() => expect(gets().length).toBe(before + 2));
  });

  it("keeps the draft and does not refetch on a hot language switch", async () => {
    const i18n = await view();
    const claudeRegion = await region("Claude Pro");
    fireEvent.change(within(claudeRegion).getByLabelText(en.burnRate.calibration.observedPct), {
      target: { value: "12" },
    });
    const count = requests.length;
    const search = window.location.search;
    await act(async () => {
      await i18n.changeLanguage("es");
    });
    const spanish = await region("Claude Pro");
    const pct = within(spanish).getByLabelText(
      es.burnRate.calibration.observedPct,
    ) as HTMLInputElement;
    expect(pct.value).toBe("12");
    expect(within(spanish).getAllByText(es.quota.estimated).length).toBeGreaterThan(0);
    expect(requests.length).toBe(count);
    expect(window.location.search).toBe(search);
  });
});

describe("Burn rate states", () => {
  it("explains where the subscriptions file goes when the config is missing", async () => {
    quotasBody = () => json(quotas({ config: { status: "missing" }, subscriptions: [] }));
    await view();
    expect(await screen.findByText(en.burnRate.config.missing.title)).toBeTruthy();
    const text = document.body.textContent ?? "";
    expect(text).toContain("one-more-token/subscriptions.json");
    expect(text).not.toMatch(/\/Users\/|\/home\//);
  });

  it("shows an error with retry when the config is invalid", async () => {
    let calls = 0;
    quotasBody = () => {
      calls += 1;
      return json(
        calls === 1 ? quotas({ config: { status: "invalid" }, subscriptions: [] }) : quotas(),
      );
    };
    await view();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(en.burnRate.config.invalid.split("(")[0] ?? "");
    fireEvent.click(within(alert).getByRole("button", { name: en.common.retry }));
    expect(await region("Claude Pro")).toBeTruthy();
  });

  it("invites to add subscriptions when the config lists none", async () => {
    quotasBody = () => json(quotas({ subscriptions: [] }));
    await view();
    expect(await screen.findByText(en.burnRate.config.empty.title)).toBeTruthy();
  });

  it("warns when the calibrations file is invalid and disables the form", async () => {
    quotasBody = () => json(quotas({ calibrations: { status: "invalid" } }));
    calibrationsBody = () => json({ error: "unsafe calibration storage" }, 409);
    await view();
    const claudeRegion = await region("Claude Pro");
    const calibration = within(claudeRegion).getByRole("region", {
      name: en.burnRate.calibration.title,
    });
    expect(within(calibration).getByRole("alert").textContent).toContain(
      en.burnRate.calibration.invalid.split("(")[0] ?? "",
    );
    expect(
      (
        within(calibration).getByRole("button", {
          name: en.burnRate.calibration.submit,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("shows a safe error with retry when quotas fail", async () => {
    let calls = 0;
    quotasBody = () => {
      calls += 1;
      return calls === 1 ? new Response("PRIVATE", { status: 500 }) : json(quotas());
    };
    await view();
    expect(await screen.findByText(en.burnRate.error)).toBeTruthy();
    expect(document.body.textContent).not.toContain("PRIVATE");
    fireEvent.click(screen.getByRole("button", { name: en.common.retry }));
    expect(await region("Claude Pro")).toBeTruthy();
  });
});

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Summary } from "../../cli/src/summary/contract";
import en from "../src/i18n/en.json";
import es from "../src/i18n/es.json";
import { createI18n } from "../src/i18n/i18n";
import { SummaryView } from "../src/views/SummaryView";
import { memoryStorage } from "./helpers";

const from = "2026-01-01T00:00:00.000Z";
const to = "2026-01-08T00:00:00.000Z";
const empty = (): Summary => ({
  period: { from, to },
  sessions: 0,
  turns: 0,
  usageTurns: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  pricing: { basis: "historical", observedAt: null, staleUsageTurns: 0 },
  costs: {
    reported: { usd: null, known: 0, unknown: 0 },
    computed: { usd: null, known: 0, unknown: 0 },
  },
  days: [{ date: "2026-01-01", tokens: 0 }],
  issues: { warning: 0, error: 0, critical: 0 },
  quota: { status: "unavailable" },
});
const success = (): Summary => ({
  ...empty(),
  sessions: 2,
  turns: 3,
  usageTurns: 2,
  tokens: { input: 1000000, output: 100000, cacheRead: 300000, cacheWrite: 100000, total: 1500000 },
  costs: {
    reported: { usd: 0, known: 1, unknown: 1 },
    computed: { usd: 12, known: 1, unknown: 1 },
  },
  days: [{ date: "2026-01-01", tokens: 1500000 }],
});
const fetcher = vi.fn<typeof fetch>();
beforeEach(() => {
  window.history.replaceState(null, "", `/?agent=pi&from=${from}&to=${to}`);
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
async function view() {
  const i18n = await createI18n({ storage: memoryStorage(), browserLanguages: ["en"] });
  render(
    <I18nextProvider i18n={i18n}>
      <SummaryView />
    </I18nextProvider>,
  );
  return i18n;
}
function respond(body = empty()) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

describe("Summary", () => {
  it("loads without ingesting, then retains first-ingest guidance and honest quota state", async () => {
    let resolve!: (response: Response) => void;
    fetcher.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await view();
    expect(screen.getByRole("status").textContent).toContain(en.common.loading);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      `/api/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
    await act(async () => {
      resolve(respond());
    });
    expect(screen.getByText(en.summary.empty.title)).toBeTruthy();
    expect(screen.getByText("pnpm omt ingest").tagName).toBe("CODE");
    expect(screen.getByText(en.summary.quotaUnavailable)).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("renders split tokens, distinct USD costs, coverage and UTC trend; hot locale switch retains metrics and range", async () => {
    fetcher.mockImplementation(async () => respond(success()));
    const i18n = await view();
    await screen.findByText("2 sessions");
    expect(screen.getAllByText("1.5 M").length).toBeGreaterThan(0);
    expect(screen.getByText("2 sessions")).toBeTruthy();
    expect(screen.getByText("3 turns")).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: en.summary.costs })).getByText("$0.00"),
    ).toBeTruthy();
    expect(screen.getByText("$12.00")).toBeTruthy();
    expect(screen.getAllByText("1 of 2 usage turns; remaining cost unknown")).toHaveLength(2);
    expect(screen.getByText(en.summary.missingPricing)).toBeTruthy();
    expect(screen.getByRole("table", { name: en.summary.trend })).toBeTruthy();
    const search = window.location.search;
    await act(async () => {
      await i18n.changeLanguage("es");
    });
    expect(screen.getAllByText("1,5 M").length).toBeGreaterThan(0);
    expect(screen.getByText(es.summary.quotaUnavailable)).toBeTruthy();
    expect(window.location.search).toBe(search);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("labels past usage as a reference-date API estimate, distinct from reported zero, in both locales", async () => {
    fetcher.mockImplementation(async () =>
      respond({
        ...success(),
        pricing: { basis: "current-reference", observedAt: "2026-10-21", staleUsageTurns: 1 },
      }),
    );
    const i18n = await view();
    await screen.findByText("2 sessions");
    const search = window.location.search;
    for (const language of ["en", "es", "en"] as const) {
      await act(async () => {
        await i18n.changeLanguage(language);
      });
      const catalog = language === "en" ? en : es;
      const locale = language === "en" ? "en-US" : "es-ES";
      const costs = screen.getByRole("region", { name: catalog.summary.costs });
      expect(within(costs).getByText(catalog.summary.estimatedApiEquivalent).tagName).toBe("DT");
      expect(within(costs).getByText(catalog.summary.reported).tagName).toBe("DT");
      expect(within(costs).queryByText(catalog.summary.computed)).toBeNull();
      for (const amount of [0, 12]) {
        const expected = new Intl.NumberFormat(locale, {
          style: "currency",
          currency: "USD",
        }).format(amount);
        expect(within(costs).getByText(expected.replace(/\s+/g, " "))).toBeTruthy();
      }
      expect(
        within(costs).getByText(
          i18n.t("summary.referenceDate", {
            date: new Intl.DateTimeFormat(locale, {
              dateStyle: "medium",
              timeZone: "UTC",
            }).format(new Date("2026-10-21T00:00:00Z")),
          }),
        ),
      ).toBeTruthy();
      expect(within(costs).getByText(catalog.summary.referenceNote)).toBeTruthy();
      expect(within(costs).getByText(catalog.summary.referenceAssumptions)).toBeTruthy();
      expect(
        within(costs).getByText(i18n.t("summary.stalePricing", { count: 1, formatted: "1" })),
      ).toBeTruthy();
      expect(within(costs).getByText("pnpm omt ingest").tagName).toBe("CODE");
      expect(within(costs).getByText(catalog.summary.missingPricing)).toBeTruthy();
      expect(window.location.search).toBe(search);
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retains the historical computed label without current-reference assumptions", async () => {
    fetcher.mockImplementation(async () => respond(success()));
    await view();
    await screen.findByText("2 sessions");
    expect(screen.getByText(en.summary.computed)).toBeTruthy();
    expect(screen.queryByText(en.summary.estimatedApiEquivalent)).toBeNull();
    expect(screen.queryByText(en.summary.referenceNote)).toBeNull();
  });

  it("uses safe catalog errors, retry, and labels unknown costs rather than zero", async () => {
    fetcher.mockResolvedValueOnce(new Response("PRIVATE_ERROR", { status: 500 }));
    fetcher.mockResolvedValueOnce(
      respond({
        ...success(),
        costs: {
          reported: { usd: null, known: 0, unknown: 2 },
          computed: { usd: null, known: 0, unknown: 2 },
        },
      }),
    );
    await view();
    expect((await screen.findByRole("alert")).textContent).toContain(en.summary.error);
    expect(document.body.textContent).not.toContain("PRIVATE_ERROR");
    fireEvent.click(screen.getByRole("button", { name: en.common.retry }));
    await screen.findByText("2 sessions");
    expect(screen.getAllByText(en.summary.unknown)).toHaveLength(2);
    expect(screen.queryByText("$0.00")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("syncs selectable ranges to URL, preserves other parameters, and refreshes on back/forward", async () => {
    fetcher.mockImplementation(async () => respond(success()));
    await view();
    await screen.findByText("2 sessions");
    const initial = window.location.href;
    fireEvent.click(screen.getByRole("radio", { name: en.summary.last30Days }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    const selected = window.location.href;
    const params = new URLSearchParams(window.location.search);
    expect(params.get("agent")).toBe("pi");
    expect(Date.parse(params.get("to") ?? "") - Date.parse(params.get("from") ?? "")).toBe(
      30 * 86400000,
    );
    act(() => {
      window.history.replaceState(null, "", initial);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(
      screen.getByRole("radio", { name: en.summary.last7Days }).getAttribute("aria-checked"),
    ).toBe("true");
    act(() => {
      window.history.replaceState(null, "", selected);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
    expect(
      screen.getByRole("radio", { name: en.summary.last30Days }).getAttribute("aria-checked"),
    ).toBe("true");
  });
});

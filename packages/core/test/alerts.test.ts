import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AlertsFileSchema,
  alertKey,
  evaluateAlerts,
  loadAlertsFile,
  parseAlertsFile,
  readSentAlertKeys,
  recordSentAlert,
  renderAlert,
} from "../src/alerts";
import alertEn from "../src/alerts/i18n/en.json";
import alertEs from "../src/alerts/i18n/es.json";
import { openDatabase } from "../src/db/database";
import { migrate } from "../src/db/migrate";
import type {
  QuotaSubscriptionReport,
  QuotaWindow,
  QuotaWindowKindReport,
} from "../src/quota/engine";

const NOW = "2026-11-10T12:00:00.000Z";
/** Intl puts a no-break space before the currency and the percent sign. */
const flat = (value: string) => value.replace(/\u00a0/g, " ");

const window = (over: Partial<QuotaWindow> = {}): QuotaWindow => ({
  startsAt: "2026-11-10T09:00:00.000Z",
  endsAt: "2026-11-10T14:00:00.000Z",
  usedUsd: 8.2,
  usedTokens: 120_000,
  limitUsd: 10,
  limitTokens: null,
  estimatedPct: 82.5,
  overLimitUsd: null,
  limitSource: "calibrated",
  estimated: true,
  ...over,
});

const kindReport = (over: Partial<QuotaWindowKindReport> = {}): QuotaWindowKindReport => ({
  kind: "five_hours",
  unit: "usd",
  limitSource: "calibrated",
  limitUsd: 10,
  limitTokens: null,
  windows: [window()],
  current: window(),
  resetsAt: "2026-11-10T14:00:00.000Z",
  projection: null,
  overLimitUsd: 0,
  calibration: { readings: [], meanAbsoluteDeviationPct: null },
  ...over,
});

const subscription = (over: Partial<QuotaSubscriptionReport> = {}): QuotaSubscriptionReport => ({
  id: "chatgpt-plus",
  planId: "chatgpt-plus",
  label: "ChatGPT Plus",
  provider: "openai",
  startedAt: null,
  endedAt: null,
  monthlyPriceUsd: 20,
  windows: [kindReport()],
  extractedValue: { apiEquivalentUsd: 0, unpricedTurns: 0, paidUsd: 20, ratio: null },
  ...over,
});

const alert = {
  id: "plus-80",
  subscriptionId: "chatgpt-plus",
  windowKind: "five_hours" as const,
  thresholdPct: 80,
  channel: "telegram",
};

describe("alerts configuration", () => {
  it("accepts a strict file of alerts", () => {
    const parsed = parseAlertsFile(JSON.stringify({ version: 1, alerts: [alert] }));
    expect(parsed).toEqual({ ok: true, file: { version: 1, alerts: [alert] } });
  });

  it("rejects the boundaries of the threshold range", () => {
    for (const thresholdPct of [0, 100.5]) {
      const parsed = parseAlertsFile(
        JSON.stringify({ version: 1, alerts: [{ ...alert, thresholdPct }] }),
      );
      expect(parsed).toEqual({ ok: false, error: "invalid alerts config" });
    }
    for (const thresholdPct of [1, 100]) {
      expect(
        parseAlertsFile(JSON.stringify({ version: 1, alerts: [{ ...alert, thresholdPct }] })).ok,
      ).toBe(true);
    }
  });

  it("rejects duplicate ids, unknown channels and unknown keys", () => {
    const cases = [
      { version: 1, alerts: [alert, alert] },
      { version: 1, alerts: [{ ...alert, channel: "carrier-pigeon" }] },
      { version: 1, alerts: [{ ...alert, extra: true }] },
      { version: 2, alerts: [alert] },
      { version: 1, alerts: [{ ...alert, windowKind: "daily" }] },
    ];
    for (const value of cases) {
      expect(parseAlertsFile(JSON.stringify(value))).toEqual({
        ok: false,
        error: "invalid alerts config",
      });
    }
    expect(AlertsFileSchema.safeParse({ version: 1, alerts: [alert] }).success).toBe(true);
  });

  it("rejects malformed json and a channel nobody registered", () => {
    expect(parseAlertsFile("{")).toEqual({ ok: false, error: "invalid alerts config" });
    expect(parseAlertsFile(JSON.stringify({ version: 1, alerts: [alert] }), ["gotify"])).toEqual({
      ok: false,
      error: "invalid alerts config",
    });
  });

  it("treats a missing file as no alerts and an unreadable one as an error", () => {
    const home = mkdtempSync(join(tmpdir(), "omt-alerts-"));
    try {
      expect(loadAlertsFile(join(home, "alerts.json"))).toEqual({
        ok: true,
        file: { version: 1, alerts: [] },
      });
      // A directory is readable as a path but never as a file.
      expect(loadAlertsFile(home)).toEqual({ ok: false, error: "alerts config unreadable" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("alert evaluation", () => {
  const evaluate = (
    over: {
      alerts?: Parameters<typeof evaluateAlerts>[0]["alerts"];
      subscriptions?: QuotaSubscriptionReport[];
      sent?: string[];
      now?: string;
    } = {},
  ) =>
    evaluateAlerts({
      alerts: over.alerts ?? [alert],
      subscriptions: over.subscriptions ?? [subscription()],
      sent: over.sent ?? [],
      now: over.now ?? NOW,
    });

  it("fires at the threshold itself and reports the figures of the instance", () => {
    const events = evaluate({
      subscriptions: [
        subscription({ windows: [kindReport({ windows: [window({ estimatedPct: 80 })] })] }),
      ],
    });
    expect(events).toEqual([
      {
        alertId: "plus-80",
        channel: "telegram",
        subscriptionId: "chatgpt-plus",
        subscriptionLabel: "ChatGPT Plus",
        windowKind: "five_hours",
        windowStart: "2026-11-10T09:00:00.000Z",
        windowEnd: "2026-11-10T14:00:00.000Z",
        thresholdPct: 80,
        estimatedPct: 80,
        usedUsd: 8.2,
        limitUsd: 10,
        limitSource: "calibrated",
      },
    ]);
  });

  it("stays quiet below the threshold, without a limit, or outside the active instance", () => {
    const quiet = [
      [window({ estimatedPct: 79.9 })],
      [window({ estimatedPct: null, limitUsd: null, limitSource: "unknown" as const })],
      [window({ startsAt: "2026-11-10T04:00:00.000Z", endsAt: "2026-11-10T09:00:00.000Z" })],
      [window({ startsAt: "2026-11-11T09:00:00.000Z", endsAt: "2026-11-11T14:00:00.000Z" })],
    ];
    for (const windows of quiet) {
      expect(
        evaluate({ subscriptions: [subscription({ windows: [kindReport({ windows })] })] }),
      ).toEqual([]);
    }
  });

  it("treats the instance start as active and its end as closed", () => {
    const active = evaluate({
      subscriptions: [
        subscription({
          windows: [
            kindReport({
              windows: [
                window({ startsAt: NOW, endsAt: "2026-11-10T17:00:00.000Z", estimatedPct: 80 }),
              ],
            }),
          ],
        }),
      ],
    });
    expect(active.map((event) => event.windowStart)).toEqual([NOW]);

    const closed = evaluate({
      subscriptions: [
        subscription({
          windows: [
            kindReport({
              windows: [
                window({ startsAt: "2026-11-10T07:00:00.000Z", endsAt: NOW, estimatedPct: 80 }),
              ],
            }),
          ],
        }),
      ],
    });
    expect(closed).toEqual([]);
  });

  it("keeps one message per window instance and fires again on a new one", () => {
    const sent = [alertKey("plus-80", "2026-11-10T09:00:00.000Z")];
    expect(evaluate({ sent })).toEqual([]);

    const next = kindReport({
      windows: [
        window(),
        window({ startsAt: "2026-11-10T14:00:00.000Z", endsAt: "2026-11-10T19:00:00.000Z" }),
      ],
    });
    const events = evaluate({
      subscriptions: [subscription({ windows: [next] })],
      sent,
      // The first instance is over; the second one is the active one now.
      now: "2026-11-10T15:00:00.000Z",
    });
    expect(events.map((event) => event.windowStart)).toEqual(["2026-11-10T14:00:00.000Z"]);
  });

  it("ignores alerts of a subscription or a window kind that no longer exists", () => {
    expect(evaluate({ subscriptions: [] })).toEqual([]);
    expect(evaluate({ subscriptions: [subscription({ id: "other-plan" })] })).toEqual([]);
    expect(
      evaluate({
        alerts: [{ ...alert, windowKind: "monthly" }],
        subscriptions: [subscription()],
      }),
    ).toEqual([]);
  });

  it("reports every configured alert that crosses its threshold", () => {
    // A higher threshold on the same instance stays quiet; two crossed thresholds both fire.
    expect(
      evaluate({ alerts: [alert, { ...alert, id: "plus-95", thresholdPct: 95 }] }),
    ).toHaveLength(1);
    const both = evaluate({
      alerts: [alert, { ...alert, id: "plus-70", thresholdPct: 70, channel: "telegram" }],
    });
    expect(both.map((event) => event.alertId)).toEqual(["plus-80", "plus-70"]);
  });
});

describe("alert rendering", () => {
  const event = evaluateAlerts({
    alerts: [alert],
    subscriptions: [subscription()],
    sent: [],
    now: NOW,
  })[0];
  if (!event) throw new Error("expected one alert event");

  it("writes the figures and the estimate note in both languages", () => {
    const es = flat(renderAlert(event, "es").text);
    const en = flat(renderAlert(event, "en").text);
    expect(renderAlert(event, "es").subject).toContain("ChatGPT Plus");
    for (const text of [es, en]) {
      expect(text).toContain("2026-11-10 14:00 UTC");
    }
    // Intl decimal separators follow the language (spec §8.5); Spanish keeps a space before %.
    for (const figure of ["82,5 %", "80,0 %", "8,20", "10,00"]) expect(es).toContain(figure);
    for (const figure of ["82.5%", "80.0%", "8.20", "10.00"]) expect(en).toContain(figure);
    expect(es).toContain("5 h");
    expect(en).toContain("5 h");
    expect(es).not.toBe(en);
    expect(es).toMatch(/estimad/i);
    expect(en).toMatch(/estimated/i);
  });

  it("says the limit is unknown instead of inventing a figure", () => {
    const unknown = evaluateAlerts({
      alerts: [alert],
      subscriptions: [
        subscription({
          windows: [
            kindReport({
              windows: [window({ limitUsd: null, limitSource: "unknown" })],
              limitUsd: null,
              limitSource: "unknown",
            }),
          ],
        }),
      ],
      sent: [],
      now: NOW,
    })[0];
    if (!unknown) throw new Error("expected one alert event");
    expect(flat(renderAlert(unknown, "es").text)).toContain(alertEs["value.unknownLimit"]);
    expect(flat(renderAlert(unknown, "en").text)).toContain(alertEn["value.unknownLimit"]);
  });

  it("keeps both alert catalogs in lockstep", () => {
    expect(Object.keys(alertEs).sort()).toEqual(Object.keys(alertEn).sort());
    const vars = (value: string) =>
      [...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(alertEn) as (keyof typeof alertEn)[]) {
      expect(alertEn[key]).not.toBe("");
      expect(alertEs[key]).not.toBe("");
      expect(vars(alertEs[key])).toEqual(vars(alertEn[key]));
    }
  });
});

describe("alert state", () => {
  let db: Awaited<ReturnType<typeof openDatabase>>;

  beforeEach(async () => {
    db = await openDatabase(":memory:");
    await migrate(db);
  });

  afterEach(() => {
    db.close();
  });

  it("records a sent instance and reads the keys back", async () => {
    const sent = {
      alertId: "plus-80",
      subscriptionId: "chatgpt-plus",
      kind: "five_hours" as const,
      windowStart: "2026-11-10T09:00:00.000Z",
      thresholdPct: 80,
      sentAt: NOW,
    };
    expect(await readSentAlertKeys(db)).toEqual(new Set());
    await recordSentAlert(db, sent);
    expect(await readSentAlertKeys(db)).toEqual(new Set(["plus-80:2026-11-10T09:00:00.000Z"]));
  });

  it("refuses a duplicate instance and stores no message text", async () => {
    const sent = {
      alertId: "plus-80",
      subscriptionId: "chatgpt-plus",
      kind: "five_hours" as const,
      windowStart: "2026-11-10T09:00:00.000Z",
      thresholdPct: 80,
      sentAt: NOW,
    };
    await recordSentAlert(db, sent);
    // One instance, one row: the primary key makes a second delivery impossible.
    await expect(
      recordSentAlert(db, { ...sent, sentAt: "2026-11-10T13:00:00.000Z" }),
    ).rejects.toThrow();
    const columns = await db.all<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'alert_notifications' ORDER BY ordinal_position",
    );
    expect(columns.map((column) => column.column_name)).toEqual([
      "alert_id",
      "subscription_id",
      "kind",
      "window_start",
      "threshold_pct",
      "sent_at",
    ]);
  });
});

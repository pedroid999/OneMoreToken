import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AlertChannel,
  type AlertMessage,
  createAlertChannelRegistry,
  type Database,
  hashContent,
  loadPricing,
  migrate,
  openDatabase,
  PricingFileSchema,
} from "@omt/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alertChannels } from "../src/alerts/channels";
import { startAlertScheduler } from "../src/alerts/scheduler";
import { runAlertPass } from "../src/alerts/service";
import { createTelegramChannel, type FetchLike } from "../src/alerts/telegram";
import { parseServeOptions } from "../src/options";

let db: Database;
let home: string;
let configPath: string;
let calibrationsPath: string;
let alertsPath: string;

/** Inside the 10:00–15:00Z five-hour window the fixture opens. */
const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const CURRENT_PRICING = hashContent(JSON.stringify(PricingFileSchema.parse(loadPricing())));

/** Plan `opencode-go` allows 12 USD per five hours and the turn spends 6: the window sits at 50 %. */
const config = {
  version: 1,
  subscriptions: [{ id: "go", planId: "opencode-go", match: [{ provider: "opencode-go" }] }],
};

const alert = {
  id: "go-40",
  subscriptionId: "go",
  windowKind: "five_hours",
  thresholdPct: 40,
  channel: "telegram",
};

function telegram(name: string): AlertChannel & { messages: AlertMessage[] } {
  const messages: AlertMessage[] = [];
  return {
    id: name,
    messages,
    send: async (message) => {
      messages.push(message);
    },
  };
}

function failing(): AlertChannel & { attempts: number } {
  let attempts = 0;
  return {
    id: "telegram",
    get attempts() {
      return attempts;
    },
    send: async () => {
      attempts += 1;
      throw new Error("telegram request failed");
    },
  };
}

beforeEach(async () => {
  db = await openDatabase(":memory:");
  await migrate(db);
  home = mkdtempSync(join(tmpdir(), "omt-alerts-"));
  configPath = join(home, "subscriptions.json");
  calibrationsPath = join(home, "calibrations.json");
  alertsPath = join(home, "alerts.json");
  writeFileSync(configPath, JSON.stringify(config));
  await db.run(
    `INSERT INTO sessions (id, source_id, agent, started_at, format_version) VALUES
      ('s', 'src', 'gentle-shell', '2026-10-10T09:00:00Z', '3')`,
  );
  await db.run(
    `INSERT INTO ingest_checkpoints VALUES ('src', 'content', '1', '2026-10-10T12:00:00Z', $1)`,
    [CURRENT_PRICING],
  );
  await db.run(
    `INSERT INTO turns (id, session_id, idx, role, ts, provider) VALUES
      ('go-1', 's', 0, 'assistant', '2026-10-10T10:00:00Z', 'opencode-go')`,
  );
  await db.run(
    `INSERT INTO usage (turn_id, input_tokens, output_tokens, reported_cost_usd, computed_cost_usd)
     VALUES ('go-1', 100, 60, NULL, 6)`,
  );
});

afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

const pass = (over: { channels?: AlertChannel[]; now?: number; diagnostics?: string[] } = {}) => {
  const diagnostics = over.diagnostics ?? [];
  return runAlertPass(db, {
    configPath,
    calibrationsPath,
    alertsPath,
    language: "es",
    now: () => over.now ?? NOW,
    channels: createAlertChannelRegistry(over.channels ?? [telegram("telegram")]),
    onDiagnostic: (message) => diagnostics.push(message),
  });
};

const rows = async () => (await db.all("SELECT * FROM alert_notifications")).length;

describe("alert pass", () => {
  it("delivers one message per crossed instance and records it", async () => {
    writeFileSync(alertsPath, JSON.stringify({ version: 1, alerts: [alert] }));
    const channel = telegram("telegram");
    const result = await pass({ channels: [channel] });

    expect(result).toEqual({ configured: 1, due: 1, sent: 1, failed: 0 });
    expect(channel.messages).toHaveLength(1);
    expect(channel.messages[0]?.subject).toContain("50,0");
    expect(channel.messages[0]?.subject).toContain("OpenCode Go");
    expect(channel.messages[0]?.text).toContain("40,0");
    expect(await rows()).toBe(1);

    // Second pass, same instance: nothing leaves again.
    expect(await pass({ channels: [channel] })).toEqual({
      configured: 1,
      due: 0,
      sent: 0,
      failed: 0,
    });
    expect(channel.messages).toHaveLength(1);
  });

  it("stays quiet below the threshold", async () => {
    writeFileSync(
      alertsPath,
      JSON.stringify({ version: 1, alerts: [{ ...alert, thresholdPct: 60 }] }),
    );
    const channel = telegram("telegram");
    expect(await pass({ channels: [channel] })).toEqual({
      configured: 1,
      due: 0,
      sent: 0,
      failed: 0,
    });
    expect(channel.messages).toEqual([]);
    expect(await rows()).toBe(0);
  });

  it("never alerts on a closed window", async () => {
    writeFileSync(alertsPath, JSON.stringify({ version: 1, alerts: [alert] }));
    const channel = telegram("telegram");
    // 16:00Z is past the 15:00Z end of the only window in the data.
    expect(
      (await pass({ channels: [channel], now: Date.parse("2026-10-10T16:00:00.000Z") })).due,
    ).toBe(0);
    expect(channel.messages).toEqual([]);
  });

  it("retries a failed delivery and records only the successful one", async () => {
    writeFileSync(alertsPath, JSON.stringify({ version: 1, alerts: [alert] }));
    const broken = failing();
    const diagnostics: string[] = [];
    expect(await pass({ channels: [broken], diagnostics })).toEqual({
      configured: 1,
      due: 1,
      sent: 0,
      failed: 1,
    });
    expect(diagnostics).toEqual([
      'alerts: delivery failed for alert "go-40": telegram request failed',
    ]);
    expect(await rows()).toBe(0);

    const channel = telegram("telegram");
    expect(await pass({ channels: [channel] })).toEqual({
      configured: 1,
      due: 1,
      sent: 1,
      failed: 0,
    });
    expect(channel.messages).toHaveLength(1);
    expect(await rows()).toBe(1);
  });

  it("does nothing at all without a configured alert", async () => {
    const channel = telegram("telegram");
    // Missing file and an empty list are both "no alerts", never an error.
    expect(await pass({ channels: [channel] })).toEqual({
      configured: 0,
      due: 0,
      sent: 0,
      failed: 0,
    });
    writeFileSync(alertsPath, JSON.stringify({ version: 1, alerts: [] }));
    const diagnostics: string[] = [];
    expect(await pass({ channels: [channel], diagnostics })).toEqual({
      configured: 0,
      due: 0,
      sent: 0,
      failed: 0,
    });
    expect(diagnostics).toEqual([]);
    expect(channel.messages).toEqual([]);
  });

  it("reports a broken configuration once and sends nothing", async () => {
    writeFileSync(alertsPath, "{ not json");
    const channel = telegram("telegram");
    const diagnostics: string[] = [];
    expect(await pass({ channels: [channel], diagnostics })).toEqual({
      configured: 0,
      due: 0,
      sent: 0,
      failed: 0,
    });
    expect(diagnostics).toEqual(["alerts: invalid alerts config"]);
    expect(channel.messages).toEqual([]);
  });

  it("refuses an alert whose channel is not registered", async () => {
    writeFileSync(
      alertsPath,
      JSON.stringify({ version: 1, alerts: [{ ...alert, channel: "gotify" }] }),
    );
    const diagnostics: string[] = [];
    await pass({ diagnostics });
    expect(diagnostics).toEqual(["alerts: invalid alerts config"]);
    expect(await rows()).toBe(0);
  });
});

describe("telegram channel", () => {
  const message = { subject: "Cuota al 40,0 %: Go", text: "Ventana de 5 h" };

  it("posts the message to the bot endpoint with its chat", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const channel = createTelegramChannel({
      botToken: "123:secret",
      chatId: "42",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 200 };
      },
    });
    await channel.send(message);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.telegram.org/bot123:secret/sendMessage");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0]?.init.body ?? "{}")).toEqual({
      chat_id: "42",
      text: "Cuota al 40,0 %: Go\n\nVentana de 5 h",
      disable_web_page_preview: true,
    });
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports a refused request without the token", async () => {
    const channel = createTelegramChannel({
      botToken: "123:secret",
      chatId: "42",
      fetch: async () => ({ ok: false, status: 403 }),
    });
    await expect(channel.send(message)).rejects.toThrow("telegram responded 403");
  });

  it("keeps the token out of a transport failure", async () => {
    const channel = createTelegramChannel({
      botToken: "123:secret",
      chatId: "42",
      fetch: async (url) => {
        // The real fetch quotes the URL in its error, so the channel must not forward it.
        throw new Error(`request to ${url} failed`);
      },
    });
    await expect(channel.send(message)).rejects.toThrow("telegram request failed");
    await expect(channel.send(message)).rejects.not.toThrow(/secret/);
  });

  it("trims the message to the API limit", async () => {
    let body = "";
    const channel = createTelegramChannel({
      botToken: "t",
      chatId: "1",
      fetch: async (_url, init) => {
        body = init.body;
        return { ok: true, status: 200 };
      },
    });
    await channel.send({ subject: "s", text: "x".repeat(5000) });
    expect((JSON.parse(body) as { text: string }).text).toHaveLength(4096);
  });
});

describe("alert scheduler", () => {
  const scheduler = (over: { intervalMs?: number; onError?: (error: unknown) => void } = {}) =>
    startAlertScheduler(db, {
      configPath,
      calibrationsPath,
      alertsPath,
      language: "es",
      now: () => NOW,
      channels: createAlertChannelRegistry([telegram("telegram")]),
      intervalMs: over.intervalMs ?? 0,
      ...(over.onError ? { onError: over.onError } : {}),
    });

  it("runs one pass at startup and shares the pass in flight", async () => {
    writeFileSync(alertsPath, JSON.stringify({ version: 1, alerts: [alert] }));
    const running = scheduler();
    expect(running.runOnce()).toBe(running.runOnce());
    await running.runOnce();
    await running.stop();
    expect(await rows()).toBe(1);
  });

  it("keeps running the interval after a broken configuration", async () => {
    // An unreadable alerts file makes every pass a no-op with one diagnostic, never a crash.
    rmSync(alertsPath, { force: true });
    writeFileSync(alertsPath, "{ not json");
    const diagnostics: string[] = [];
    const running = startAlertScheduler(db, {
      configPath,
      calibrationsPath,
      alertsPath,
      language: "es",
      now: () => NOW,
      channels: createAlertChannelRegistry([telegram("telegram")]),
      intervalMs: 25,
      onDiagnostic: (message) => diagnostics.push(message),
    });
    await vi.waitFor(() => expect(diagnostics.length).toBeGreaterThan(1));
    await running.stop();
  });

  it("reports a failed pass through onError instead of crashing the server", async () => {
    const errors: unknown[] = [];
    writeFileSync(alertsPath, JSON.stringify({ version: 1, alerts: [alert] }));
    const brokenDb = {
      all: async () => {
        throw new Error("database unavailable");
      },
      run: async () => {
        throw new Error("database unavailable");
      },
    } as unknown as Database;
    const running = startAlertScheduler(brokenDb, {
      configPath,
      calibrationsPath,
      alertsPath,
      language: "es",
      now: () => NOW,
      channels: createAlertChannelRegistry([telegram("telegram")]),
      intervalMs: 0,
      onError: (error) => errors.push(error),
    });
    await running.stop();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("database unavailable");
  });

  it("waits for the pass in flight on stop", async () => {
    writeFileSync(alertsPath, JSON.stringify({ version: 1, alerts: [alert] }));
    const running = scheduler({ intervalMs: 25 });
    await running.stop();
    expect(await rows()).toBe(1);
  });
});

describe("alert channels", () => {
  it("exists only when both credentials are present", () => {
    expect(alertChannels({}).size).toBe(0);
    expect(alertChannels({ telegramBotToken: "t" }).size).toBe(0);
    expect(alertChannels({ telegramChatId: "c" }).size).toBe(0);
    expect([...alertChannels({ telegramBotToken: "t", telegramChatId: "c" }).keys()]).toEqual([
      "telegram",
    ]);
  });
});

describe("serve options for alerts", () => {
  const HOME = "/home/someone";
  const parse = (args: string[], env: NodeJS.ProcessEnv = {}) => parseServeOptions(args, env, HOME);

  it("defaults to the alerts file beside the subscriptions and no credentials", () => {
    const parsed = parse([]);
    expect(parsed).toMatchObject({
      ok: true,
      options: {
        alertsConfigPath: join(HOME, ".config", "one-more-token", "alerts.json"),
        alertIntervalMs: 3_600_000,
        telegramBotToken: undefined,
        telegramChatId: undefined,
      },
    });
  });

  it("reads the Telegram credentials from flags first and the environment second", () => {
    const env = { OMT_TELEGRAM_BOT_TOKEN: "from-env", OMT_TELEGRAM_CHAT_ID: "chat-env" };
    expect(parse([], env)).toMatchObject({
      ok: true,
      options: { telegramBotToken: "from-env", telegramChatId: "chat-env" },
    });
    expect(
      parse(["--telegram-bot-token", "from-flag", "--telegram-chat-id", "chat-flag"], env),
    ).toMatchObject({
      ok: true,
      options: { telegramBotToken: "from-flag", telegramChatId: "chat-flag" },
    });
    // A blank value is "no credentials", not an empty secret.
    expect(parse([], { OMT_TELEGRAM_BOT_TOKEN: "  ", OMT_TELEGRAM_CHAT_ID: "" })).toMatchObject({
      ok: true,
      options: { telegramBotToken: undefined, telegramChatId: undefined },
    });
  });

  it("accepts a custom alerts path and interval", () => {
    expect(parse(["--alerts-config", "/tmp/a.json", "--alert-interval-ms", "0"])).toMatchObject({
      ok: true,
      options: { alertsConfigPath: "/tmp/a.json", alertIntervalMs: 0 },
    });
  });

  it("rejects a bad interval with one exact message", () => {
    for (const value of ["abc", "86400001"]) {
      expect(parse(["--alert-interval-ms", value])).toEqual({
        ok: false,
        error: `invalid --alert-interval-ms "${value}": expected an integer between 0 and 86400000`,
      });
    }
  });
});

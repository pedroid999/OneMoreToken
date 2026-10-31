import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CalibrationsFileSchema, type Database, migrate, openDatabase } from "@omt/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { defaultCalibrationsPath, defaultSubscriptionsConfigPath } from "../src/options";

let db: Database;
let home: string;
let path: string;
let configPath: string;

const config = {
  version: 1,
  subscriptions: [
    { id: "claude", planId: "claude-pro", match: [{ provider: "claude-bridge" }] },
    { id: "go", planId: "opencode-go", match: [{ provider: "opencode-go" }] },
  ],
};

beforeEach(async () => {
  db = await openDatabase(":memory:");
  await migrate(db);
  home = mkdtempSync(join(tmpdir(), "omt-calibrations-"));
  path = join(home, "data", "one-more-token", "calibrations.json");
  configPath = join(home, "config", "subscriptions.json");
  mkdirSync(join(home, "config"));
  writeFileSync(configPath, JSON.stringify(config));
});
afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

const app = () => createApp(db, { calibrations: { path }, subscriptions: { configPath } });
const reading = {
  subscriptionId: "claude",
  windowKind: "five_hours",
  observedPct: 42,
  observedAt: "2026-10-28T10:00:00Z",
};
const post = (body: unknown, headers: Record<string, string> = {}) =>
  app().request("/api/calibrations", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const list = async () =>
  (await (await app().request("/api/calibrations")).json()) as {
    calibrations: { id: string }[];
  };
const bytes = () => readFileSync(path, "utf8");

describe("default paths", () => {
  it("keeps calibrations in the data home and subscriptions in the config home", () => {
    expect(defaultCalibrationsPath({}, "/home/u")).toBe(
      "/home/u/.local/share/one-more-token/calibrations.json",
    );
    expect(defaultCalibrationsPath({ XDG_DATA_HOME: "/xd" }, "/home/u")).toBe(
      "/xd/one-more-token/calibrations.json",
    );
    expect(defaultSubscriptionsConfigPath({}, "/home/u")).toBe(
      "/home/u/.config/one-more-token/subscriptions.json",
    );
    expect(defaultSubscriptionsConfigPath({ XDG_CONFIG_HOME: "/xc" }, "/home/u")).toBe(
      "/xc/one-more-token/subscriptions.json",
    );
  });
});

describe("/api/calibrations", () => {
  it("lists nothing and creates no file when there are no calibrations", async () => {
    expect(await list()).toEqual({ calibrations: [] });
    expect(() => statSync(path)).toThrow();
  });

  it("stores a reading in a private file, lists it and mirrors it into the database", async () => {
    const res = await post({ ...reading, note: "console" });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };
    expect(created).toEqual({
      id: expect.stringMatching(/^[a-z0-9-]+$/),
      ...reading,
      note: "console",
    });

    expect(await list()).toEqual({ calibrations: [created] });
    expect(CalibrationsFileSchema.parse(JSON.parse(bytes()))).toEqual({
      version: 1,
      calibrations: [created],
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "data", "one-more-token")).mode & 0o777).toBe(0o700);
    expect(
      await db.all("SELECT id, subscription_id, window_kind, observed_pct, note FROM calibrations"),
    ).toEqual([
      {
        id: created.id,
        subscription_id: "claude",
        window_kind: "five_hours",
        observed_pct: 42,
        note: "console",
      },
    ]);
  });

  it.each([
    ["an unknown subscription", { ...reading, subscriptionId: "nope" }],
    ["a window the plan does not have", { ...reading, windowKind: "monthly" }],
    ["a negative percentage", { ...reading, observedPct: -1 }],
    ["a percentage above 100", { ...reading, observedPct: 101 }],
    ["a reading from the future", { ...reading, observedAt: "2999-01-01T00:00:00Z" }],
    ["unknown fields", { ...reading, extra: true }],
    ["malformed JSON", "{"],
  ])("rejects %s and leaves the file unchanged", async (_name, body) => {
    await post(reading);
    const before = bytes();
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid calibration" });
    expect(bytes()).toBe(before);
  });

  it("requires JSON and a loopback origin for writes", async () => {
    expect((await post(reading, { "content-type": "text/plain" })).status).toBe(415);
    expect((await post(reading, { origin: "https://evil.example" })).status).toBe(403);
    expect(() => statSync(path)).toThrow();
  });

  it("deletes a reading and answers 404 for an unknown one", async () => {
    const created = (await (await post(reading)).json()) as { id: string };
    const res = await app().request(`/api/calibrations/${created.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await list()).toEqual({ calibrations: [] });
    expect(await db.all("SELECT * FROM calibrations")).toEqual([]);

    const missing = await app().request("/api/calibrations/nope", { method: "DELETE" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "calibration not found" });
  });

  it("never overwrites a corrupt file: reads and writes fail with a fixed error", async () => {
    mkdirSync(join(home, "data", "one-more-token"), { recursive: true });
    writeFileSync(path, "{ not json");
    const read = await app().request("/api/calibrations");
    expect(read.status).toBe(409);
    expect(await read.json()).toEqual({ error: "unsafe calibration storage" });
    expect((await post(reading)).status).toBe(409);
    expect(bytes()).toBe("{ not json");
  });

  it("never follows a symlinked calibrations file", async () => {
    mkdirSync(join(home, "data", "one-more-token"), { recursive: true });
    const elsewhere = join(home, "elsewhere.json");
    writeFileSync(elsewhere, JSON.stringify({ version: 1, calibrations: [] }));
    symlinkSync(elsewhere, path);
    expect((await post(reading)).status).toBe(409);
    expect(readFileSync(elsewhere, "utf8")).toBe(JSON.stringify({ version: 1, calibrations: [] }));
  });

  it("rejects every reading while the subscriptions config is invalid", async () => {
    writeFileSync(configPath, "{");
    const res = await post(reading);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid calibration" });
  });
});

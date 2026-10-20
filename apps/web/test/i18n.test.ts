import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import en from "../src/i18n/en.json";
import es from "../src/i18n/es.json";
import { formatNumber, formatTokensM, formatUsd } from "../src/i18n/format";
import { createI18n, LANGUAGE_STORAGE_KEY, resolveInitialLanguage } from "../src/i18n/i18n";

type Catalog = { [key: string]: string | Catalog };

function flatten(catalog: Catalog, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(catalog)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out[path] = value;
    else Object.assign(out, flatten(value, path));
  }
  return out;
}

const flatEs = flatten(es);
const flatEn = flatten(en);
const variables = (text: string) => [...text.matchAll(/{{\s*(\w+)\s*}}/g)].map((m) => m[1]).sort();

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

describe("catalogs (spec §8.5)", () => {
  it("es and en have exactly the same keys", () => {
    expect(Object.keys(flatEs).sort()).toEqual(Object.keys(flatEn).sort());
  });

  it("have no empty translations", () => {
    for (const [key, value] of Object.entries({ ...flatEs, ...flatEn })) {
      expect(value.trim(), key).not.toBe("");
    }
  });

  it("use the same interpolation variables in both languages", () => {
    for (const key of Object.keys(flatEn)) {
      expect(variables(flatEs[key] ?? ""), key).toEqual(variables(flatEn[key] ?? ""));
    }
  });

  it("keep proper names untranslated", () => {
    expect(flatEs["app.name"]).toBe("One More Token");
    expect(flatEs["nav.burnRate"]).toBe("Burn rate");
  });
});

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

describe("source code (spec §11.3)", () => {
  const files = sourceFiles(SRC).map((path) => ({ path, text: readFileSync(path, "utf8") }));

  it("only references translation keys present in the catalogs", () => {
    const missing: string[] = [];
    for (const { path, text } of files) {
      for (const match of text.matchAll(/\bt\(\s*["'`]([\w.]+)["'`]/g)) {
        const key = match[1] ?? "";
        const exists = key in flatEn || Object.keys(flatEn).some((k) => k.startsWith(`${key}_`));
        if (!exists) missing.push(`${path}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("has no hardcoded visible text in accessibility or hint attributes", () => {
    const offenders: string[] = [];
    for (const { path, text } of files.filter((f) => f.path.endsWith(".tsx"))) {
      for (const match of text.matchAll(
        /\b(aria-label|title|placeholder|alt)="[^"]*[A-Za-z][^"]*"/g,
      )) {
        offenders.push(`${path}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("resolveInitialLanguage", () => {
  it("prefers a valid stored choice", () => {
    expect(resolveInitialLanguage("en", ["es-ES"])).toBe("en");
  });

  it("ignores an invalid stored value and uses the first supported browser language", () => {
    expect(resolveInitialLanguage("fr", ["fr-FR", "en-US", "es"])).toBe("en");
  });

  it("falls back to Spanish when the browser offers neither language", () => {
    expect(resolveInitialLanguage(null, ["fr-FR", "de"])).toBe("es");
    expect(resolveInitialLanguage(null, [])).toBe("es");
  });
});

describe("createI18n", () => {
  it("starts in the detected language and persists nothing until the user chooses", async () => {
    const storage = memoryStorage();
    const i18n = await createI18n({ storage, browserLanguages: ["en-GB"] });
    expect(i18n.language).toBe("en");
    expect(storage.data.size).toBe(0);
  });

  it("switches language in place and persists the choice", async () => {
    const storage = memoryStorage();
    const i18n = await createI18n({ storage, browserLanguages: ["es-ES"] });
    expect(i18n.t("nav.settings")).toBe(flatEs["nav.settings"]);

    await i18n.changeLanguage("en");
    expect(i18n.t("nav.settings")).toBe(flatEn["nav.settings"]);
    expect(storage.data.get(LANGUAGE_STORAGE_KEY)).toBe("en");
  });

  it("pluralizes with plural rules, not concatenation", async () => {
    const i18n = await createI18n({ storage: memoryStorage(), browserLanguages: ["es"] });
    expect(i18n.t("session.count", { count: 1 })).toBe("1 sesión");
    expect(i18n.t("session.count", { count: 3 })).toBe("3 sesiones");
    await i18n.changeLanguage("en");
    expect(i18n.t("session.count", { count: 1 })).toBe("1 session");
    expect(i18n.t("session.count", { count: 0 })).toBe("0 sessions");
  });
});

describe("Intl formatters", () => {
  it("formats tokens in millions with one decimal per language (spec §7.2, §8.5)", () => {
    expect(formatTokensM(1_500_000, "es")).toBe("1,5\u00a0M");
    expect(formatTokensM(1_500_000, "en")).toBe("1.5\u00a0M");
    expect(formatTokensM(12_345_678, "es")).toBe("12,3\u00a0M");
    expect(formatTokensM(0, "en")).toBe("0.0\u00a0M");
  });

  it("formats dollars per language", () => {
    expect(formatUsd(12, "en")).toBe("$12.00");
    expect(formatUsd(12, "es")).toBe("12,00\u00a0US$");
  });

  it("formats plain numbers with language separators", () => {
    expect(formatNumber(12345.5, "en")).toBe("12,345.5");
    expect(formatNumber(12345.5, "es")).toBe("12.345,5");
  });
});

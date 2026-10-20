import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEME_PREFS,
  parseDensity,
  parseThemePrefs,
  resolveTheme,
} from "../src/prefs/preferences";

describe("resolveTheme (spec §8.3)", () => {
  it("follows a dark OS with the chosen dark variant in system mode", () => {
    expect(resolveTheme({ mode: "system", darkVariant: "wave" }, true)).toBe("wave");
    expect(resolveTheme({ mode: "system", darkVariant: "dragon" }, true)).toBe("dragon");
  });

  it("uses Lotus for a light OS in system mode", () => {
    expect(resolveTheme({ mode: "system", darkVariant: "dragon" }, false)).toBe("lotus");
  });

  it("ignores the OS when the mode is explicit", () => {
    expect(resolveTheme({ mode: "light", darkVariant: "wave" }, true)).toBe("lotus");
    expect(resolveTheme({ mode: "dark", darkVariant: "wave" }, false)).toBe("wave");
    expect(resolveTheme({ mode: "dark", darkVariant: "dragon" }, false)).toBe("dragon");
  });
});

describe("parseThemePrefs", () => {
  it("defaults to system mode with Wave", () => {
    expect(DEFAULT_THEME_PREFS).toEqual({ mode: "system", darkVariant: "wave" });
    expect(parseThemePrefs(null)).toEqual(DEFAULT_THEME_PREFS);
  });

  it("reads a stored choice", () => {
    expect(parseThemePrefs('{"mode":"dark","darkVariant":"dragon"}')).toEqual({
      mode: "dark",
      darkVariant: "dragon",
    });
  });

  it("replaces invalid or partial values with defaults", () => {
    expect(parseThemePrefs("not json")).toEqual(DEFAULT_THEME_PREFS);
    expect(parseThemePrefs('{"mode":"neon","darkVariant":"dragon"}')).toEqual({
      mode: "system",
      darkVariant: "dragon",
    });
    expect(parseThemePrefs('{"mode":"light"}')).toEqual({ mode: "light", darkVariant: "wave" });
    expect(parseThemePrefs("[]")).toEqual(DEFAULT_THEME_PREFS);
  });
});

describe("parseDensity (spec §8.2)", () => {
  it("accepts compact and falls back to comfortable", () => {
    expect(parseDensity("compact")).toBe("compact");
    expect(parseDensity("comfortable")).toBe("comfortable");
    expect(parseDensity(null)).toBe("comfortable");
    expect(parseDensity("tiny")).toBe("comfortable");
  });
});

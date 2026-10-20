import { describe, expect, it } from "vitest";
import { contrastRatio } from "../src/theme/contrast";
import { buildThemeCss } from "../src/theme/css";
import { BASE_TOKENS, SEMANTIC_COLORS, THEME_TOKENS, type ThemeName } from "../src/theme/tokens";
import { buildVegaConfig } from "../src/theme/vega";

const THEMES = Object.keys(THEME_TOKENS.themes) as ThemeName[];
const TEXT_TOKENS = ["fg", "fg-muted", "accent", "success", "warning", "danger", "info"] as const;
const SURFACES = ["bg", "surface", "surface-raised"] as const;

describe("contrastRatio", () => {
  it("matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#FFFFFF", "#FFFFFF")).toBeCloseTo(1, 5);
    expect(contrastRatio("#777777", "#FFFFFF")).toBeCloseTo(4.48, 2);
  });
});

describe("theme tokens (spec §8.3)", () => {
  it("offer a light theme and at least one dark theme as defaults", () => {
    const { light, dark } = THEME_TOKENS.defaults;
    expect(THEME_TOKENS.themes[light].appearance).toBe("light");
    expect(THEME_TOKENS.themes[dark].appearance).toBe("dark");
    expect(THEMES.sort()).toEqual(["dragon", "lotus", "wave"]);
  });

  it.each(THEMES)("%s defines every semantic token and an ordered chart series", (name) => {
    const theme = THEME_TOKENS.themes[name];
    expect(Object.keys(theme.colors).sort()).toEqual([...SEMANTIC_COLORS].sort());
    expect(theme.chart.length).toBeGreaterThanOrEqual(8);
    expect(new Set(theme.chart.map((c) => c.toLowerCase())).size).toBe(theme.chart.length);
  });
});

describe("WCAG AA contrast (spec §8.4)", () => {
  for (const name of THEMES) {
    const { colors, chart } = THEME_TOKENS.themes[name];
    for (const token of TEXT_TOKENS) {
      for (const surface of SURFACES) {
        it(`${name}: ${token} on ${surface} reaches 4.5:1`, () => {
          expect(contrastRatio(colors[token], colors[surface])).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
    for (const token of ["fg", "fg-muted"] as const) {
      it(`${name}: ${token} on selection reaches 4.5:1`, () => {
        expect(contrastRatio(colors[token], colors.selection)).toBeGreaterThanOrEqual(4.5);
      });
    }
    for (const surface of SURFACES) {
      it(`${name}: border-strong and chart colors on ${surface} reach 3:1`, () => {
        for (const color of [colors["border-strong"], ...chart]) {
          expect(contrastRatio(color, colors[surface]), color).toBeGreaterThanOrEqual(3);
        }
      });
    }
  }
});

describe("buildThemeCss", () => {
  const css = buildThemeCss(THEME_TOKENS, BASE_TOKENS);

  it("emits one block of color custom properties per theme", () => {
    for (const name of THEMES) {
      expect(css).toContain(`:root[data-theme="${name}"] {`);
    }
    expect(css).toContain(`--color-bg: ${THEME_TOKENS.themes.wave.colors.bg};`);
    expect(css).toContain(
      `--color-surface-raised: ${THEME_TOKENS.themes.lotus.colors["surface-raised"]};`,
    );
    expect(css).toContain(`--chart-1: ${THEME_TOKENS.themes.dragon.chart[0]};`);
  });

  it("declares color-scheme so native controls follow the theme", () => {
    expect(css).toMatch(/data-theme="lotus"\] \{[^}]*color-scheme: light;/);
    expect(css).toMatch(/data-theme="wave"\] \{[^}]*color-scheme: dark;/);
  });

  it("emits a spacing scale for each density (spec §8.2)", () => {
    expect(css).toContain("--space-unit: 4px;");
    expect(css).toContain(':root[data-density="compact"] {\n  --space-unit: 3px;');
    expect(css).toContain("--space-4: calc(var(--space-unit) * 4);");
  });

  it("zeroes motion under prefers-reduced-motion (spec §8.4)", () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*:root \{\s*--motion-duration-fast: 0ms;\s*--motion-duration-base: 0ms;/,
    );
  });

  it("emits typography tokens with the terminal font first", () => {
    expect(css).toContain('--font-mono: "FiraCode Nerd Font", "Fira Code"');
    expect(css).toContain("--font-size-md: 0.875rem;");
  });
});

describe("buildVegaConfig (spec §8.2)", () => {
  it.each(THEMES)("%s uses the theme chart series and tokens", (name) => {
    const theme = THEME_TOKENS.themes[name];
    const config = buildVegaConfig(theme, BASE_TOKENS);
    expect(config.range?.category).toEqual(theme.chart);
    expect(config.background).toBe("transparent");
    expect(config.axis?.labelColor).toBe(theme.colors["fg-muted"]);
    expect(config.axis?.domainColor).toBe(theme.colors.border);
    expect(config.legend?.labelColor).toBe(theme.colors.fg);
    expect(config.font).toContain("FiraCode Nerd Font");
  });
});

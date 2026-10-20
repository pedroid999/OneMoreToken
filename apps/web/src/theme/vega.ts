import type { Config } from "vega-lite";
import type { BaseTokens, Theme } from "./tokens";

// Vega-Lite theme generated from the same tokens as the CSS (spec §8.2).
export function buildVegaConfig(theme: Theme, base: BaseTokens): Config {
  const { colors } = theme;
  const font = base.font.mono.join(", ");
  return {
    background: "transparent",
    font,
    padding: 0,
    view: { stroke: "transparent" },
    range: { category: [...theme.chart] },
    title: { color: colors.fg, font, fontWeight: 500, anchor: "start" },
    axis: {
      labelColor: colors["fg-muted"],
      titleColor: colors["fg-muted"],
      domainColor: colors.border,
      tickColor: colors.border,
      gridColor: colors.border,
      gridOpacity: 0.4,
      labelFont: font,
      titleFont: font,
      titleFontWeight: 400,
    },
    legend: {
      labelColor: colors.fg,
      titleColor: colors["fg-muted"],
      labelFont: font,
      titleFont: font,
    },
    header: { labelColor: colors.fg, titleColor: colors["fg-muted"] },
    mark: { color: colors.accent },
    rule: { color: colors.border },
    text: { color: colors.fg },
  };
}

import type { BaseTokens, ThemeName, ThemesFile } from "./tokens";

// Turns data/theme tokens into CSS custom properties (spec §8.2). Themes are selected with
// :root[data-theme], densities with :root[data-density]; see index.html for the boot script.

const quoteFont = (family: string) =>
  /^[a-z-]+$/i.test(family) && !family.includes(" ") ? family : `"${family}"`;

function block(selector: string, vars: Array<[string, string | number]>): string {
  return `${selector} {\n${vars.map(([k, v]) => `  --${k}: ${v};`).join("\n")}\n}`;
}

export function buildThemeCss(themes: ThemesFile, base: BaseTokens): string {
  const shared: Array<[string, string | number]> = [
    ["font-mono", base.font.mono.map(quoteFont).join(", ")],
    ["font-sans", base.font.sans.map(quoteFont).join(", ")],
    ...Object.entries(base.fontSize).map(([k, v]) => [`font-size-${k}`, v] as [string, string]),
    ...Object.entries(base.fontWeight).map(([k, v]) => [`font-weight-${k}`, v] as [string, number]),
    ...Object.entries(base.lineHeight).map(([k, v]) => [`line-height-${k}`, v] as [string, number]),
    ["space-unit", base.density.comfortable.spaceUnit],
    ...Object.entries(base.space).map(
      ([k, v]) => [`space-${k}`, `calc(var(--space-unit) * ${v})`] as [string, string],
    ),
    ...Object.entries(base.radius).map(([k, v]) => [`radius-${k}`, v] as [string, string]),
    ...Object.entries(base.borderWidth).map(([k, v]) => [`border-${k}`, v] as [string, string]),
    ...Object.entries(base.layout).map(([k, v]) => [`layout-${kebab(k)}`, v] as [string, string]),
    ["motion-duration-fast", base.motion.durationFast],
    ["motion-duration-base", base.motion.durationBase],
    ["motion-easing", base.motion.easing],
  ];

  const themeBlocks = (Object.keys(themes.themes) as ThemeName[]).map((name) => {
    const theme = themes.themes[name];
    const vars: Array<[string, string]> = [
      ...Object.entries(theme.colors).map(([k, v]) => [`color-${k}`, v] as [string, string]),
      ...theme.chart.map((c, i) => [`chart-${i + 1}`, c] as [string, string]),
    ];
    return block(`:root[data-theme="${name}"]`, vars).replace(
      /\n\}$/,
      `\n  color-scheme: ${theme.appearance};\n}`,
    );
  });

  return [
    "/* Generated from data/theme by apps/web/src/theme/css.ts. Do not edit. */",
    block(":root", shared),
    block(':root[data-density="compact"]', [["space-unit", base.density.compact.spaceUnit]]),
    ...themeBlocks,
    "@media (prefers-reduced-motion: reduce) {\n  :root {\n    --motion-duration-fast: 0ms;\n    --motion-duration-base: 0ms;\n  }\n}",
    "",
  ].join("\n\n");
}

function kebab(value: string): string {
  return value.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

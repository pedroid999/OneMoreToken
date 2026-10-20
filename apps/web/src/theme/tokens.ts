import { z } from "zod";
import baseJson from "../../../../data/theme/base.json";
import themesJson from "../../../../data/theme/themes.json";

// Design tokens are data (spec §8.2): this module only validates and types data/theme/*.json.

export const SEMANTIC_COLORS = [
  "bg",
  "surface",
  "surface-raised",
  "selection",
  "border",
  "border-strong",
  "fg",
  "fg-muted",
  "accent",
  "success",
  "warning",
  "danger",
  "info",
] as const;
export type SemanticColor = (typeof SEMANTIC_COLORS)[number];

const hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

const ThemeSchema = z.object({
  label: z.string().min(1),
  appearance: z.enum(["light", "dark"]),
  source: z.string().min(1),
  colors: z.strictObject(
    Object.fromEntries(SEMANTIC_COLORS.map((name) => [name, hex])) as Record<
      SemanticColor,
      typeof hex
    >,
  ),
  chart: z.array(hex).min(8),
  adjustments: z.record(z.string(), z.object({ from: hex, reason: z.string().min(1) })),
});
export type Theme = z.infer<typeof ThemeSchema>;

const ThemeNameSchema = z.enum(["wave", "dragon", "lotus"]);
export type ThemeName = z.infer<typeof ThemeNameSchema>;

const ThemesFileSchema = z.object({
  version: z.literal(1),
  defaults: z.object({ light: ThemeNameSchema, dark: ThemeNameSchema }),
  themes: z.record(ThemeNameSchema, ThemeSchema),
});
export type ThemesFile = z.infer<typeof ThemesFileSchema>;

const scale = <T extends z.ZodType>(value: T) => z.record(z.string(), value);

const BaseFileSchema = z.object({
  version: z.literal(1),
  font: z.object({ mono: z.array(z.string()).min(1), sans: z.array(z.string()).min(1) }),
  fontSize: scale(z.string()),
  fontWeight: scale(z.number()),
  lineHeight: scale(z.number()),
  density: z.object({
    comfortable: z.object({ spaceUnit: z.string() }),
    compact: z.object({ spaceUnit: z.string() }),
  }),
  space: scale(z.number().nonnegative()),
  radius: scale(z.string()),
  borderWidth: scale(z.string()),
  layout: scale(z.string()),
  motion: z.object({ durationFast: z.string(), durationBase: z.string(), easing: z.string() }),
});
export type BaseTokens = z.infer<typeof BaseFileSchema>;

export const THEME_TOKENS: ThemesFile = ThemesFileSchema.parse(themesJson);
export const BASE_TOKENS: BaseTokens = BaseFileSchema.parse(baseJson);
export const THEME_NAMES = Object.keys(THEME_TOKENS.themes) as ThemeName[];

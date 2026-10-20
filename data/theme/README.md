# data/theme/

Single source of design tokens (spec §8.2). `apps/web` turns them into CSS custom properties and the Vega-Lite theme; no component uses hand-written values.

- `themes.json`: semantic colors and the ordered chart series for each Kanagawa variant. Wave (dark, default) comes from the author's gentle-shell and Zellij `kanagawa` theme; Dragon (deeper dark) and Lotus (light) come from [kanagawa.nvim](https://github.com/rebelot/kanagawa.nvim).
- `base.json`: typography, spacing scale per density, radii, borders, layout sizes and motion.

## Contrast

`pnpm check` enforces WCAG AA (spec §8.4):

- `fg`, `fg-muted`, `accent`, `success`, `warning`, `danger` and `info` reach 4.5:1 on `bg`, `surface` and `surface-raised`.
- `fg` and `fg-muted` also reach 4.5:1 on `selection`.
- `border-strong` and every chart color reach 3:1 on `bg`, `surface` and `surface-raised`.

When an original Kanagawa tone fails, adjust its lightness, keep its hue, and record the original under `adjustments` with the reason.

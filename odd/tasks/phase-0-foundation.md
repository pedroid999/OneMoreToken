# Phase 0 — Foundation

Feature document for spec §12 phase 0. Product intent lives in `docs/spec.md`; specs below quote it verbatim.
Branch: `feat/phase-0-foundation` (from `develop`).

## Specs

- S1 (spec §12, phase 0 deliverable): "Monorepo, `pnpm check`, AGENTS.md, README con créditos a Gentle-AI (§11.4), esquema y migraciones iniciales, tokens de tema, componentes base e i18n"
- S2 (spec §12, phase 0 closing criterion): "`pnpm check` en verde; tema claro y oscuro con contraste AA; cambio de idioma ES/EN en caliente"
- S3 (spec §11.1): "TypeScript estricto en todo el proyecto" · "Node 22+ con pnpm (monorepo)" · "DuckDB (`@duckdb/node-api`), un único proceso escritor" · "Zod" · "Hono, API que devuelve datos ya agregados" · "React + Vite" · "Vega-Lite" · "CSS con custom properties generadas desde los tokens de `data/theme/`" · "i18next + react-i18next, formatos con `Intl`" · "Vitest, Biome, `tsc --noEmit`"
- S4 (spec §11.2): repository structure `data/{pricing.json,subscriptions.json,theme/}`, `packages/core/`, `packages/adapters/`, `apps/cli/` ("omt ingest | watch | serve"), `apps/web/` with "src/i18n/  # Catálogos es.json, en.json y glosario"
- S5 (spec §4): tables `sources`, `sessions`, `turns`, `usage`, `tool_calls`, `subagent_runs`, `profiles`, `turn_profile`, `pricing`, `subscriptions`, `quota_windows`, `calibrations`, `commits`, `ingest_issues`; "el esquema exacto se define en `packages/core` con Zod y migraciones SQL numeradas"; "Precios y límites son datos, no código: ficheros JSON versionados con fechas de vigencia."
- S6 (spec §8.2): "Fuente única de tokens (color, tipografía, espaciado, radios, bordes, movimiento) en `data/theme/`, convertidos a CSS custom properties. Ningún componente usa valores escritos a mano." · "Componentes base reutilizables con todos sus estados definidos: reposo, hover, foco, activo, deshabilitado, cargando, vacío y error." · "Densidad seleccionable (cómoda / compacta)" · "El tema de Vega-Lite se genera desde los mismos tokens."
- S7 (spec §8.3): "Claro y oscuro elegibles: selector Sistema / Claro / Oscuro, persistido y sin parpadeo al cargar." · "Variantes: oscuro basado en Kanagawa Wave (con Dragon como alternativa más profunda) y claro basado en Kanagawa Lotus." · "Tokens semánticos: `bg`, `surface`, `surface-raised`, `border`, `fg`, `fg-muted`, `accent`, `success`, `warning`, `danger`, `info` y una serie ordenada de colores para gráficos." · "Tipografía: una monoespaciada con cifras tabulares para datos, números y código (idealmente la misma familia que use el usuario en la terminal)"
- S8 (spec §8.4): "Contraste WCAG AA en ambos temas. Algunos tonos atenuados de Kanagawa pueden no llegar: se ajustan los tokens, no se ignora la regla." · "Foco siempre visible y navegación completa por teclado." · "Se respeta `prefers-reduced-motion`."
- S9 (spec §8.5): "Selector de idioma Español / English, accesible desde ajustes y desde la paleta de comandos. Por defecto se toma el idioma del navegador (español si no es ninguno de los dos) y la elección se persiste." · "Ningún texto visible escrito en el código. Todo pasa por claves de traducción en inglés (`quota.window.fiveHours`) con catálogos `es` y `en` que deben tener exactamente las mismas claves." · "Formatos según idioma: números, fechas, horas y separadores con `Intl` (p. ej., `1,5 M` frente a `1.5 M`)." · "Plurales correctos con reglas de pluralización, no con concatenaciones." · "Cambio en caliente, sin recargar la página y conservando la vista y los filtros." · "un glosario mínimo (sesión/session, ventana/window, perfil/profile, cuota/quota…) en `apps/web/src/i18n/glossary.md`."
- S10 (spec §11.3): "`pnpm check` falla si a un catálogo le falta una clave (§8.5)." · "La UI usa solo tokens del sistema de diseño y componentes base; nada de colores ni medidas sueltas (§8.2)."
- S11 (spec §11.4): README ends with the official "Built with Gentle-AI" badge, image URL kept exactly, followed by "Independent project, built with Gentle-AI and gentle-shell."

## Tasks

- [x] T1 — S1, S3, S4: pnpm workspace, strict TS, Biome, Vitest, `pnpm check`, package skeletons · inline · commit: 8f85ec1
- [x] T2 — S5: core Zod schemas, numbered SQL migrations, DuckDB migration runner, `data/pricing.json` + `data/subscriptions.json` with Zod validation · inline · commit: a75c0d9 (Risk: item 1, initial migration; own commit)
- [x] T3 — S6, S7, S8: `data/theme/` tokens (Wave, Dragon, Lotus) from user palette, CSS custom properties + Vega-Lite theme generator, AA contrast test · inline · commit: 56881c3
- [x] T4 — S9, S10: i18n (i18next, `es`/`en`, detection, persistence, `Intl` formatters, plurals), key-parity and hardcoded-text checks, glossary · inline · commit: 3f75da8
- [x] T5 — S6, S7, S8, S9: web shell (React + Vite), no-flicker theme selector, density, language hot switch, base components with all states, status bar, token-only CSS check · gentle-ai-worker (context backstop) · commit: 2e769e1
- [x] T6 — S1, S3, S4, S11: CLI skeleton (`omt serve` with Hono + migrations, `ingest`/`watch` placeholders), README dev instructions · gentle-ai-worker (parallel, disjoint surfaces) · commit: 3c10ec4

Slices: slice 1 = 8f85ec1..a75c0d9 (core foundation). Slice 2 = 56881c3..3f75da8 (theme + i18n). Slice 3 = 3c10ec4..2e769e1 (CLI + web shell).

## Log

- L1 (user, 2026-10-20): "Vamos con el desarrollo especificado en docs/spec.md"
- L2 (user decision): scope "Solo Fase 0 (recomendado)"; palette source "Leer tus configs" (read theme files under `~/.config/zellij` and `~/.gentle-shell`).
- L3 (evidence): gentle-shell theme `~/.gentle-shell/agent/themes/kanagawa.json` is Kanagawa Wave (bg `#1F1F28`, surface `#2A2A37`, border `#54546D`, fg `#DCD7BA`, accent crystalBlue `#7E9CD8`, error peachRed `#FF5D62`, warning roninYellow `#FF9E3B`, muted springViolet1 `#938AA9`); Zellij uses its built-in `kanagawa` theme. Terminal font: FiraCode Nerd Font (alacritty).
- L5 (decision): AA rule enforced by tests: `fg`, `fg-muted`, `accent`, `success`, `warning`, `danger`, `info` ≥ 4.5:1 on `bg`/`surface`/`surface-raised`; `fg`/`fg-muted` ≥ 4.5:1 on `selection`; `border-strong` and chart ≥ 3:1. Failing Kanagawa tones are lightness-adjusted, originals recorded in `themes.json` `adjustments`. Lotus border uses lotusViolet1 because the reference `#DCD5AC` is 1.2:1 on bg.
- L6 (decision): TypeScript 7 ships no JS compiler API, so hardcoded JSX text is caught by Biome `style/noJsxLiterals` (error, `apps/web/src/**/*.tsx`) plus a test for literal `aria-label`/`title`/`placeholder`/`alt` and unknown `t()` keys.
- L7 (decision, T5 worker): Agents and Tools views marked phase 2 (spec §12 names neither). Command palette and Vega-Lite rendering are not in the phase 0 deliverable. Layout responds via flex-wrap only: no breakpoint token exists.
- L8 (evidence): `pnpm check` exit 0, 13 test files / 213 tests; `pnpm --filter @omt/web build` ok. Browser check (Playwright, vite preview): Wave dark renders; switching to Light + Español applies live without reload (page marker kept), route `/settings` kept, choices persisted in localStorage. `omt serve --port 0` smoke: `/api/health` → `{"status":"ok","schemaVersion":1}`.
- L9 (open): Vite 8 warns that its future native config loader will not accept extensionless TS imports or JSON imports without attributes; the current loader works.
- L4 (evidence): kanagawa.nvim `colors.lua` verified; spec §8.3 table lists Lotus orange `#CC6D2E` but the official value is `lotusOrange = "#cc6d00"`. Official values are used.
- L10 (user decision): review the branch in slices without rewriting history (whole branch hit `lens_context_budget_exceeded`).
- L11 (evidence, native review): slice 8f85ec1..a75c0d9 (core) approved, lineage review-e7965375def4c583, authority burned. Slice 3f75da8..3c10ec4 (CLI) approved, lineage review-a05b266d2ce3a253, authority burned. Slices a75c0d9..3f75da8 (theme + i18n) and 3c10ec4..2e769e1 (web shell) assessed medium, `reviewDue: false`: no review required.
- L12 (open, advisory review findings, non-blocking, separate work):
  - core: applied migration edits go undetected (no checksum) `migrate.ts:51-59`; rollback error can mask the original error `migrate.ts:69-73`; rollback test does not prove the half-applied table is gone `migrate.test.ts:66-77`; Zod/SQL drift test compares column names only, not types `migrate.test.ts:98-108`; pricing accepts `validTo < validFrom` `files.ts:15-16`; a plan can repeat a window kind `files.ts:63`; `Database.all<T>` casts rows without validation (BIGINT comes back as bigint) `database.ts:22-25`; `CORE_VERSION` export removed `index.ts`.
  - cli: default port 4317 collides with the OTLP gRPC collector port `options.ts:4`; shutdown drops in-flight requests `server.ts:21-23`; runtime failures in `serve` and their exit code `cli.ts:98-104`; parse-error mapping depends on Node message text `options.ts:50-64`; no Host header check on the localhost API (DNS rebinding) `app.ts:13-19`.

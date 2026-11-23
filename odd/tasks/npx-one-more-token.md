# npx one-more-token — distributable definitive version

One command (`npx one-more-token`) does: guided first-run detection → incremental ingest → serve dashboard (built UI) → open browser.

## Specs

S1: "solo haga falta ejecutar un npx OneMoreToken que hará una nueva ingesta y cargará a aplicación en el navegador" — a single `npx one-more-token` performs a fresh ingest and loads the app in the browser.
S2: "Todo + primera-vez guiada" (user answer): first run detects agent session roots, validates pricing/subscription data, then ingest + serve + open browser. Later runs go straight to ingest + serve + open.
S3: "Publicar en npm como one-more-token" (user answer): the package is published to npm as `one-more-token`; `npx one-more-token` must work on a clean machine without the repo.
S4: The dashboard UI must be served by the CLI in production (no Vite dev server): built `apps/web/dist` served by the Hono API, `/api` routes preserved.
S5: `data/` (pricing.json, subscriptions.json, theme/, tools.json, views/) ships inside the published package; prices and limits stay data, never hardcoded (AGENTS.md rule 5).
S6: `omt start` = ingest + serve + open browser, with `--no-open` and `--port` flags. Opening the browser is best-effort (no crash when no opener exists).
S7: First-run guidance prints which agent roots were detected and where the DB lives; missing roots are reported, not fatal.
S8: `pnpm check` must pass; every new behavior has a test (RED first where runnable).

## Tasks

T1 (S4): Serve built web UI from the CLI server; fallback for missing dist; tests. — commit: feat(cli): serve built dashboard
T2 (S5): Make data paths resolvable inside a published package (DATA_DIR resolution + packaged data); tests. — commit: feat(core): package data directory
T3 (S1,S2,S6,S7): `omt start` command: guided first run, ingest, serve, open browser, flags; tests. — commit: feat(cli): add omt start
T4 (S3): Publishable package: bin entry, files allowlist, prepublishOnly = pnpm check + web build; README usage. — commit: feat: npm package
T5: Publish to npm (user decision at release time; push/PR/publish remain the user's).

## Log

L1 (verbatim): "Vale , ahora queremos una versión de OneMoreToken, la definitiva para la que solo haga falta ejecutar un npx OneMoreToken que hará una nueva ingesta y cargará a aplicación en el navegador"
L2: User chose: publish to npm as one-more-token; command does everything + guided first run.
## Log (appendix)

L3: Work completed on branch feat/npx-one-more-token, commits: 84f6652 (T1), dc66c38 (T2),
a918318 (T3), f1c25e7 (T4). Smoke test: node apps/cli/dist/main.js start ingests the real
home sessions (748 files), serves /api/health, /, SPA routes and /api/summary (200s).
Publishable package verified with publishConfig (name one-more-token, bin omt,
dependencies @duckdb/node-api only). Slice note: sizes exceeded 400 lines in T3/T4;
kept one commit per unit anyway (T4 includes packaging config + README).

# Phase 4 — Git, reports, alerts, SQL console and Codex

Implements `docs/spec.md` §12 Phase 4 on `feat/phase-4-reports`, branched from `main` (`9371e91`, Phase 3 merged via #8 → develop and #9 → main).
Product intent remains in the Spanish spec; quoted requirements below are authoritative. Delivery strategy: ask-on-risk, chain strategy stacked to develop (L4): one PR per slice of about 400 authored lines, merged into develop in order; develop → main when the phase closes. Test runner: Vitest through `pnpm check`.

## Specs

- S1 (§12): "Git, informes, alertas, consola SQL, Codex"; closure: "Informe semanal generado automáticamente".
- S2 (§3): "Codex CLI | `~/.codex/sessions/` | JSONL (**verificar**) | Fase 4", with the common requirements: "Solo lectura.", "Ingesta incremental.", "Idempotencia.", "Tolerancia a errores.", "Versión del formato."
- S3 (L2 decision): Codex `rate_limits` readings are stored automatically as ChatGPT Plus calibrations, marked with origin Codex, next to the manual ones ("lo primero").
- S4 (§4, §7.1): table `commits`: "Commits de los repos detectados, enlazables a sesiones por repo + rango temporal"; view "**Git:** tokens por commit, por línea neta y por PR; sesiones sin commit («tokens huérfanos»)." Sessions view: "diff de commits asociados".
- S5 (§7.1): "**SQL:** consola sobre DuckDB con vistas guardadas."
- S6 (§9): "Informe semanal y «wrapped» mensual generados en markdown, en el idioma elegido."; §8.5: "dashboard, informes en markdown y alertas salen en el idioma elegido. La CLI y los logs técnicos quedan en inglés."
- S7 (§9): "Exportación de cualquier gráfico a PNG/SVG y de cualquier tabla a CSV."
- S8 (§9): "Alertas configurables por umbral de ventana (p. ej., 80 %) con canal enchufable; primer canal: Telegram."
- S9 (§3, §10, AGENTS hard rules): "Solo lectura. Nunca escribir ni bloquear ficheros de los agentes."; "Todo se ejecuta y almacena en local. Sin telemetría."; adapters validate with Zod and have snapshot tests over anonymized fixtures; schema changes only through a new numbered migration; UI uses tokens/base components and es/en i18n keys.

## Design (assumptions, to confirm per task)

- D1 Codex: parse `rollout-*.jsonl` (`session_meta`, `turn_context`, `token_usage_record`, `event_msg/token_count`); subagent threads link to `source.subagent.thread_spawn.parent_thread_id`. Files without usage records (2025 format) are ingested as sessions without usage and flagged with their own format version. Never store message, reasoning or tool content.
- D2 Codex quota readings: `rate_limits.primary` (`window_minutes: 300`) → `five_hours`, `secondary` (`10080`) → `weekly`; they are derived from agent data, so they live in a DB table with origin `codex` (new migration), not in the user calibrations file; the engine merges them with manual readings. The subscription is the one whose rules match the Codex turn provider.
- D3 Git: only repos that appear as session `cwd`/`repo`; read-only `git log --numstat` (no fetch, no network); PRs inferred locally from merge commit messages; session ↔ commit link by repo + session time range.
- D4 Reports: scheduled inside the server process (single DuckDB writer), markdown files under `${XDG_DATA_HOME:-~/.local/share}/one-more-token/reports/`.
- D5 Alerts: thresholds and channel credentials in the local config dir (0600), never in the repo.
- D6 SQL console: read-only queries only; saved SQL views as local JSON files.

## Tasks

- [x] T1a — S2,S9: Codex adapter (rollouts, legacy, subagent threads) wired into ingest and CLI help; route: inline. RED observed on the ingest tests (3 failing) before wiring; parser tests written before the parser but only run after it. `pnpm check` 745 tests; real-data check L5. Commit: see L5
- [ ] T1b — S3,S9: Codex `rate_limits` readings as ChatGPT Plus calibrations with origin Codex (migration, engine merge, API/UI origin).
- [ ] T2 — S4,S9: Git commits ingest and session links.
- [ ] T3 — S4: Git view and commits in the Session view.
- [ ] T4 — S5,S9: SQL console with saved views.
- [ ] T5 — S6: weekly and monthly reports in markdown, scheduled in the server.
- [ ] T6 — S7: PNG/SVG/CSV export.
- [ ] T7 — S8: threshold alerts with a pluggable channel and Telegram.
- [ ] T8 — S1: docs and real-data acceptance (weekly report generated automatically).

## Log

- L1 (user request): "empecemos la fase 4"
- L2 (user decisions, 2026-10-31): read permission "si" for `~/.codex/sessions/` (never `auth.json` or config) and read-only `git log` over the repos seen as session `cwd`, real metrics only in an isolated temporary DB, nothing committed; Codex readings: "lo primero" (store them automatically as ChatGPT Plus calibrations with origin Codex).
- L3 (evidence): 7 Codex files (2 from Sep 2025 without usage records, 5 from Oct 2026, `cli_version` 0.163-0.165, `model_provider: openai`, models `gpt-6-astra`/`gpt-6-luna`, efforts medium/high, one subagent thread). `token_count.rate_limits`: `limit_id: codex`, `primary {used_percent, window_minutes: 300, resets_at}`, `secondary {…, 10080, …}`. Existing schema: `sessions(cwd, repo, branch)` and `commits(repo, sha, authored_at, author, message, additions, deletions)` from migration 001.
- L4 (user decisions, 2026-10-31): delivery "PRs encadenadas"; chain strategy "Stacked a develop (Recomendado)". Slice boundaries are recorded here as PRs open.
- L5 (T1a evidence): adapter `codex/1`; session formats `codex-rollout/1` and `codex-legacy/1` (2025 files: session only, `missing_usage`). One `token_usage_record` = one assistant turn, `task_started` = user turn, model/effort from `turn_context`; OpenAI `input_tokens` include cached input, so cached moves to `cache_read_tokens`. Subagent threads are wrapped with the parent rollout path (`omt-codex-document/1`), resolved by the `rollout-<ts>-<thread id>.jsonl` name; role = `agent_role` or `subagent` (nickname and agent path are never stored). Real data in an isolated temp DB: files 7, persisted 7, failed 0, issues 2 (the two legacy files); source mtimes unchanged; second pass skipped 7. Child thread input + cached = 1,072,908 = the provider's `total_token_usage.input_tokens`. Disclosed gap: `gpt-6-astra` and `gpt-6-luna` have no catalog price, so their turns are unpriced until `data/pricing.json` gets them.
- L6 (T1a review): per-commit assess `medium`, `under_budget`; the stop hook offered START for 3b794fb (base 9371e91, 14 files, 964 lines), user chose "Revisar este cambio" (granted). Native review lens `review-reliability` approved and acknowledged (lineage review-6920066a3f8ce49e). Non-blocking advisories, follow-ups: (a) `apps/cli/src/ingest/service.ts:177-196` the parent index only covers the walked root, so `--path` on one day directory cannot resolve parents stored under another day; (b) `packages/adapters/codex/index.ts:96-121` `readCodexQuotaReadings` is not wired yet (T1b); (c) `service.ts:199-205` with `--since`, a child whose own mtime is older is not re-linked when its parent appears later. Slice 1 (T1a) exceeds ~400 lines (964, mostly tests, fixtures and snapshot); no cohesive split, `size:exception` recommended.
- L7 (slice 1): PR #10 `feat/phase-4-codex-adapter` (3b794fb) → develop, `size:exception` requested in the body. T1b continues on `feat/phase-4-reports` and will be slice 2, stacked on #10. T1b route: delegated writer (long-session backstop), independent verifier (migration, risk item 1).
- L8 (T1b contract): (1) new numbered migration `007_provider_quota_readings.sql`, additive only: a table of provider readings (source id, observed_at, window_kind `five_hours`|`weekly`, observed_pct 0-100, resets_at, origin `codex`), replaced per source on every re-ingest of that source (derived from agent data, never written to the user calibrations file, D2). (2) Ingest stores `readCodexQuotaReadings` output for each Codex source inside the same request; unchanged (skipped) sources keep their rows. (3) Subscription of a reading = the user subscription whose rules match provider `openai` and agent `codex` at `observed_at` (same rule semantics as turn attribution, D1 of Phase 3); readings with no matching subscription are ignored by the engine. (4) The quota engine treats them as calibration readings (limit = median implied, leave-one-out deviation) next to the manual ones; to keep one burst from dominating, use at most one provider reading per window instance (the latest observed before it ends). (5) `/api/quotas` and `/api/calibrations` list readings with `origin: "manual" | "codex"`; Codex readings are read-only (DELETE on one → the existing 404 `calibration not found`). (6) Burn rate calibration list shows the origin with es/en i18n keys; the manual form is unchanged. (7) Fix review advisories L6(a) (parents in another day directory under the same Codex root resolve even when `--path` points at one day) and L6(c) (with `--since`, a child is re-ingested when its resolved parent rollout is newer than `since`). (8) README quota/calibration section documents the Codex origin.

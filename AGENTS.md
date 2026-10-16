# AGENTS.md

Instructions for AI coding agents working on **One More Token** (`omt`): a local web dashboard that analyzes usage, cost and subscription quotas of AI coding agents (Claude Code, gentle-shell/Pi, OpenCode and others).

This file is the single source of truth for agent instructions. `CLAUDE.md` only imports it.

## Source of truth

- **Product intent lives in [`docs/spec.md`](docs/spec.md)** (written in Spanish). When a task relates to the spec, reference the exact section (e.g. `spec §5.3`) instead of paraphrasing it. Quote it verbatim when exact wording matters.
- If this file and the spec disagree, stop and ask the human.

## Language rules

| What | Language |
|---|---|
| Code, identifiers, file names, DB tables and columns | English |
| Code comments, commit messages, PR descriptions, technical docs | English |
| i18n keys | English (`quota.window.fiveHours`) |
| UI text | Never hardcoded: always an i18n key present in both `es` and `en` catalogs |
| `docs/spec.md` | Spanish (do not translate it unless asked) |

Use the glossary below so the same concept always gets the same name. "One More Token" and "Burn rate" are proper names and are never translated.

## Workflow

- Primary harness: **gentle-shell** running inside **herdr**, mostly with Claude models. Claude Code may also be used on this repo; these rules apply to both.
- Follow **ODD** (Organic Driven Development): explore before changing, keep small work small, give substantial work one feature document that references the spec.
- **herdr tabs:** the orchestrator decides when to split work into herdr tabs, only when starting a task in a clean context is a clear and necessary priority (independent units with disjoint edit surfaces, a degraded long context, or long-running work that must not block the main session). Otherwise work inline or use gentle-shell subagents.
  - Each tab gets one bounded task that points to a spec section or feature document, never a paraphrased summary.
  - Name each tab after its task.
  - Parallel tasks work in separate worktrees or branches.
  - The orchestrator stays accountable: it integrates results and runs `pnpm check` before closing.

## Commands

```bash
pnpm install        # install dependencies
pnpm check          # typecheck + lint + tests: the single "done" signal
pnpm test           # tests only (Vitest)
pnpm dev            # run the web app and API in development
pnpm omt ingest     # ingest local agent sessions
```

Nothing is done until `pnpm check` passes.

## Architecture

```
packages/core/        Schema (Zod), migrations, pricing, quota windows, profile attribution
packages/adapters/    One adapter per agent, each with anonymized fixtures
apps/cli/             omt ingest | watch | serve
apps/web/             Dashboard (React + Vite + Vega-Lite), i18n in src/i18n/
data/                 pricing.json, subscriptions.json, theme/ (design tokens)
docs/spec.md          Product spec (Spanish)
```

Stack: TypeScript (strict), Node 22+, pnpm workspaces, DuckDB (`@duckdb/node-api`), Hono, Zod, React + Vite, Vega-Lite, i18next, Vitest, Biome.

## Hard rules

1. **Read-only on agent data.** Never write to, lock or modify files of the agents we ingest. Open SQLite sources read-only. Tests use fixtures only.
2. **Single DuckDB writer.** Ingestion runs inside the server process.
3. **Adapters validate their output with Zod** and have snapshot tests: fixture in, normalized output out. A format change must break a test, not the dashboard.
4. **Never commit real session data.** Fixtures must be anonymized and stripped of secrets, paths and personal content.
5. **Prices and quota limits are data**, edited in `data/`, never hardcoded.
6. **Schema changes only through a new numbered migration.**
7. **UI uses design tokens and base components only**: no loose colors, sizes or spacing (spec §8.2).
8. **Every visible string uses an i18n key present in `es` and `en`.** `pnpm check` fails on missing keys (spec §8.5).
9. **Privacy first:** everything stays local, no telemetry, secrets redacted at ingest time.
10. **Test first** for behavior changes when a runnable test applies.

## Commits and PRs

- Conventional commits (`feat(adapters): parse opencode sqlite sessions`).
- One logical change per commit.
- PR descriptions in English: what changed, why, how it was verified, spec section it relates to.

## Glossary

| Español | English / code |
|---|---|
| sesión | session |
| turno | turn |
| ventana (de cuota) | (quota) window |
| cuota | quota |
| suscripción | subscription |
| perfil | profile |
| rol | role |
| esfuerzo | effort |
| coste calculado / reportado | computed / reported cost |
| calibración | calibration |
| adaptador | adapter |
| ingesta | ingest |
| vista guardada | saved view |

## Third-party marks

Gentle-AI, gentle-shell and related names and logos are trademarks of their author. Credit them, but never imply endorsement or official affiliation (see the README footer).

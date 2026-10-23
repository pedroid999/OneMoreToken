<h1 align="center">One More Token</h1>

<p align="center"><em>Just one more token.</em></p>

<p align="center">
  A local dashboard to explore how you use AI coding agents: tokens, cost, subscription quotas and the agent profiles behind them.
</p>

> **Status:** phase 1 in progress. Claude Code and gentle-shell/Pi metrics ingestion and the period summary are available. Quotas and profile attribution arrive in phase 3.

## What it does

One More Token reads the sessions your coding agents already store on your machine, normalizes them, and lets you explore them freely:

- **One view for every agent:** Claude Code, gentle-shell/Pi and OpenCode first, more to come.
- **Burn rate:** your 5-hour, weekly and monthly quota windows over time, with a projection of when you will hit the limit.
- **Explorer:** pivot any metric (input, output, cache, cost) by any dimension (agent, model, profile, repo, hour…) into any chart.
- **gentle-shell profiles:** compare what each routing profile really costs, by role and by kind of task.
- **Git insights:** tokens per commit, per PR, and sessions that never shipped.
- **Light and dark Kanagawa themes**, keyboard-first, in English and Spanish.

Everything runs locally. Nothing leaves your machine.

## Getting started

Requirements: Node 22+ and pnpm.

```bash
pnpm install     # install dependencies
pnpm dev         # web dev server and `omt serve` together, with reload
pnpm omt serve   # API server only (http://127.0.0.1:7317)
pnpm check       # typecheck + lint + tests
```

### Ingest local metrics

Start `pnpm omt serve` first. In another terminal:

```bash
pnpm omt ingest
pnpm omt ingest --since 2026-10-09T00:00:00Z
pnpm omt ingest --agent pi --path /absolute/session-directory
pnpm omt ingest --agent opencode --path /absolute/opencode-data-directory
pnpm omt ingest --url http://127.0.0.1:7318 --agent claude-code
```

The CLI is an HTTP client, not another DuckDB writer (spec §11.1). `--url` accepts only loopback HTTP addresses (`localhost`, `127.0.0.1`, `[::1]`), without credentials, query strings or redirects. By default the server recursively discovers `~/.claude/projects/`, `~/.gentle-shell/agent/sessions/`, `~/.pi/agent/sessions/` and the OpenCode data directory `${XDG_DATA_HOME:-~/.local/share}/opencode/`; absent defaults are ignored. `--agent` limits discovery to one adapter. `--path` requires `--agent` and an absolute directory. Symlink files and directories (including linked-home ancestors) are not followed, avoiding loops and duplicate linked homes.

OpenCode is read from its current SQLite database (`opencode.db`) and its legacy JSON `storage/` directory. The live database is never opened: `opencode.db` and `opencode.db-wal` (never `-shm`) are copied into a private temporary directory, the copy is opened read-only and then removed, so OpenCode's files are neither written nor locked; if the database changes during the copy it is retried once and otherwise counted as a failure. SQLite wins: a legacy session is ingested only when its id is absent from the database (or the database is missing), and an unreadable database skips legacy sessions too, to avoid double counting. Each OpenCode session is one source, counted in `files`; `--since` selects OpenCode sessions by their last update time. Reasoning tokens are stored as output tokens; the reported OpenCode cost is kept next to the computed cost.

`--since` accepts an ISO timestamp with timezone and selects files by **modification time only**, inclusively. It does not filter individual turns, delete older snapshots, or define the dashboard period. Ingestion reads one whole file at a time without writing or locking the source. Unchanged content, adapter versions and pricing catalog hashes are skipped; a changed pricing catalog reprices unchanged sources on the next ingest (rerun without `--since` to include older files). Appended or rewritten files replace their previous metrics snapshot on the next run. Corrupt rows become fixed diagnostics and do not stop other rows/files. Only metrics and structural metadata are persisted, never message text, titles, tool arguments/results or raw exceptions (spec §3, §10).

Each successful request prints exactly one line, for example:

```text
omt ingest: files=3 persisted=1 skipped=1 failed=1 issues=2
```

Exit status is 0 for a successful API request, even with counted file issues; 1 for invalid options or API/network failures. `watch` remains a stub (exit 2). Run `pnpm omt --help` for all options.

#### Ingestion API contract

`POST /api/ingest` accepts an `application/json` object with optional `agent` (`claude-code`, `gentle-shell`, `pi`, `opencode`), `path` (absolute directory, requires `agent`), and `since` (ISO timestamp with timezone). Unknown fields, malformed JSON and bodies exceeding 16 KiB return 400 before discovery or database access. Host protection remains enabled; hostile browser Origins return 403 and non-JSON content returns 415. Loopback HTTP Origins, including Vite's `http://localhost:5173`, are accepted; no permissive CORS headers are emitted.

The response is `IngestMetrics`, exported from `apps/cli/src/ingest/service.ts`: `{ files, persisted, skipped, failed, issues }`, all nonnegative integer counters for this request. `files` counts selected JSONL files attempted; `persisted`/`skipped` are checkpoint outcomes; `failed` counts file processing/directory discovery failures; `issues` counts newly parsed row issues plus those failures. Missing defaults and symlinks are ignored. Stored issues in unchanged files are not recounted. Filesystem/parser failures produce only safe counters, with no source paths or exception details in the response.

`createApp(db, { ingest: { roots, now } })` supports injected discovery roots and time; `roots: []` prevents home discovery in tests. All ingestion requests and health database reads share `withDatabase<T>(db, operation)` from `apps/cli/src/db-queue.ts`. Summary reads use this same queue. Source normalization and atomic snapshot persistence reuse the core `ingestSource` contract.

### Period summary

The Summary view reads local aggregates without triggering ingestion (spec §7.1–§7.2, §8.5). Select the last 7 or 30 days; explicit `from` and `to` URL parameters preserve the period through browser history and language changes. Other URL parameters are preserved, but do not filter this phase-1 summary. Dates and daily trends use UTC. Theme and density preferences still apply.

#### Summary API contract

`GET /api/summary?from=2026-01-01T00:00:00Z&to=2026-01-08T00:00:00Z` returns `Summary`, exported from `apps/cli/src/summary/contract.ts` and used as a type by the UI and API tests:

```json
{
  "period": { "from": "2026-01-01T00:00:00.000Z", "to": "2026-01-08T00:00:00.000Z" },
  "sessions": 1, "turns": 2, "usageTurns": 1,
  "tokens": { "input": 100, "output": 20, "cacheRead": 30, "cacheWrite": 40, "total": 190 },
  "pricing": { "basis": "current-reference", "observedAt": "2026-10-21", "staleUsageTurns": 0 },
  "costs": {
    "reported": { "usd": 0, "known": 1, "unknown": 0 },
    "computed": { "usd": null, "known": 0, "unknown": 1 }
  },
  "days": [
    { "date": "2026-01-01", "tokens": 190 },
    { "date": "2026-01-02", "tokens": 0 },
    { "date": "2026-01-03", "tokens": 0 },
    { "date": "2026-01-04", "tokens": 0 },
    { "date": "2026-01-05", "tokens": 0 },
    { "date": "2026-01-06", "tokens": 0 },
    { "date": "2026-01-07", "tokens": 0 }
  ],
  "issues": { "warning": 0, "error": 0, "critical": 0 },
  "quota": { "status": "unavailable" }
}
```

- Supply both bounds or neither (default: the rolling seven days ending at request time). Bounds must be finite ISO timestamps with timezone, at most millisecond precision, with `from < to`. The range may intersect at most 366 UTC calendar days. Repeated, missing, invalid or oversized bounds return HTTP 400 with exactly `{"error":"invalid summary period"}` before any database reads. Responses normalize bounds to UTC; URL-encode `+` in timezone offsets.
- Selection is by **turn timestamp**, inclusive `from`, exclusive `to`, not session start or ingestion time. `sessions` counts distinct sessions having any normalized turn in that period. `turns` counts **all normalized turns**, including user turns, while `usageTurns` counts turns with a usage row (normally assistant messages). Sessions with no turns in the period are excluded. Tools and separately recorded subagent totals are not joined or added again.
- Token fields are four disjoint categories; `total` sums each exactly once. `days` is ordered, zero-filled UTC calendar dates intersecting the period, with partial first/last days restricted to the exact timestamp bounds.
- Reported and computed USD are independent sums of **known** costs. `known` and `unknown` count usage rows for each cost independently and sum to `usageTurns`. `usd` is `null` when no costs are known; a partial sum is not a complete bill. Reported zero remains actual zero, not a claim of free usage. Missing computed coverage produces a pricing warning. No cost is inferred for user turns without usage.
- `pricing` describes the currently loaded catalog: `basis` is `current-reference` or `historical` (the default for catalogs without policy metadata); `observedAt` is its UTC `YYYY-MM-DD` reference date or `null` for historical pricing. In current-reference mode the UI labels computed cost **Estimated API equivalent**: standard/global rates at that reference date applied to past usage, **not historical billed prices or subscription charges**. Unknown cache-write TTL assumes the short rate; no fast-mode, batch discount or geographic premium is inferred. Historical catalogs retain event-date pricing and the Computed cost label.
- Computed sums and known coverage include only usage whose source checkpoint `pricing_hash` matches `hashContent(JSON.stringify(PricingFileSchema.parse(pricing)))` for the current catalog. `pricing.staleUsageTurns` counts selected usage rows with a missing or mismatched hash (including rows whose stored computed cost is already null); these count as unknown, never silently relabelled with new rates. Matching-hash missing/unresolved models are ordinary unknowns, not stale. Tokens and reported costs are unaffected. GET never rewrites stored costs: rerun `pnpm omt ingest` to reprice available source files. Stale sources no longer present remain unknown; old stored rates are never substituted.
- All numeric JSON fields are nonnegative finite numbers. Integer aggregates (including DuckDB bigint/HUGEINT results) must fit `Number.MAX_SAFE_INTEGER`; USD retains floating-point precision from stored DOUBLE values, but is also rejected above that magnitude. Nonfinite/unsafe aggregates or database failures return HTTP 500 with exactly `{"error":"summary unavailable"}` rather than silently corrupting numbers or exposing exceptions.
- `issues` counts **all currently stored** ingestion issues by severity, not just issues in the selected turn period. No source paths, messages, content, models or profile guesses are returned. Quota is explicitly unavailable until phase 3; no subscription limits or percentages are fabricated. Summary reads share the ingestion connection and `withDatabase` queue and never mutate data. Successful reads disable HTTP caching.

### Where your data lives

- The database is a single DuckDB file at `$OMT_DB` if set, otherwise `${XDG_DATA_HOME:-~/.local/share}/one-more-token/omt.duckdb`. Override it per run with `pnpm omt serve --db <path>`.
- The server binds to `127.0.0.1` by default, so it is only reachable from your machine. There is no telemetry.
- Agent session files are only read, never modified.

### Keep your Claude Code history

By default Claude Code deletes transcripts older than 30 days (`cleanupPeriodDays`), and One More Token can only analyze what is still on disk. Raise the limit in `~/.claude/settings.json`:

```json
{
  "cleanupPeriodDays": 365
}
```

## Contributing

Contributions are welcome once the first milestone lands. Read [`AGENTS.md`](AGENTS.md) for conventions; they apply to humans and agents alike. The product spec lives in [`docs/spec.md`](docs/spec.md) (in Spanish).

## License

To be decided.

---

<p align="center">
  <a href="https://github.com/Gentleman-Programming/gentle-ai">
    <img width="220" src="https://raw.githubusercontent.com/Gentleman-Programming/gentle-ai/main/docs/assets/brand/built-with-gentle-ai.png" alt="Built with Gentle-AI">
  </a>
</p>

<p align="center">
  Independent project, built with Gentle-AI and <a href="https://github.com/Gentleman-Programming/gentle-shell">gentle-shell</a>.
</p>

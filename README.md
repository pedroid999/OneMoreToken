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

The CLI is an HTTP client, not another DuckDB writer (spec §11.1). `--url` accepts only loopback HTTP addresses (`localhost`, `127.0.0.1`, `[::1]`), without credentials, query strings or redirects. By default the server recursively discovers `~/.claude/projects/`, `~/.gentle-shell/agent/sessions/`, gentle-shell subagents in `~/.gentle-shell/agent/gentle-agents/`, `~/.pi/agent/sessions/` and the OpenCode data directory `${XDG_DATA_HOME:-~/.local/share}/opencode/`; absent defaults are ignored. `--agent` limits discovery to one adapter. `--path` requires `--agent` and an absolute directory. Symlink files and directories (including linked-home ancestors) are not followed, avoiding loops and duplicate linked homes.

gentle-shell subagent transcripts (`gentle-agents/sessions/*.jsonl`, Pi v3 format) are ingested as child sessions of the gentle-shell session that launched them. The link comes from the task records in `gentle-agents/tasks/*.json`: only their metadata (task id, agent role, parent session id, `provider/model`, thinking level, linked transcript file and timestamps) is read; prompts, results, labels, working directories and threads are never stored. Each child gets one subagent run (role, model, effort, duration, summed tokens and costs). A transcript without a task record, or whose parent transcript is absent, is still ingested, without a parent or run (role unknown). `--since` selects a subagent transcript when it or one of its task records changed after the timestamp. `--path` always reads plain transcripts.

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

### Explorer API

The pivot backend for the Explorer (spec §7.2). It reads aggregates only, never mutates data, and shares the `withDatabase` queue with ingestion. Types: `ExplorerResponse` in `apps/cli/src/explorer/contract.ts`; body and saved view schemas (`ExplorerQuerySchema`, `SavedViewSchema`) in `packages/core/src/data/views.ts`.

#### `POST /api/explorer/query`

```json
{
  "metrics": ["total", "cacheHitRatio"],
  "dimensions": ["day", "agent"],
  "filters": [{ "dimension": "tool", "op": "in", "values": ["read"] }],
  "from": "2026-01-01T00:00:00Z",
  "to": "2026-01-31T00:00:00Z",
  "limit": 1000
}
```

```json
{
  "columns": [
    { "name": "day", "type": "dimension" },
    { "name": "agent", "type": "dimension" },
    { "name": "total", "type": "metric" },
    { "name": "cacheHitRatio", "type": "metric" }
  ],
  "rows": [{ "day": "2026-01-01", "agent": "pi", "total": 190, "cacheHitRatio": 0.25 }],
  "unavailable": [],
  "overlapping": false,
  "truncated": false
}
```

- **Metrics** (1–4, no duplicates): `input`, `output`, `cacheRead`, `cacheWrite`, `total` (raw token integers; the UI formats millions), `computedCost`, `reportedCost`, `cacheHitRatio`, `turns`, `sessions` (distinct). Costs are sums of known values only, `null` when none is known, never an inferred zero; each cost metric adds `<metric>Known` and `<metric>Unknown` coverage columns counting usage rows, exactly as in the Summary (computed cost is known only when priced with the current catalog). `cacheHitRatio` = cacheRead / (input + cacheRead + cacheWrite), `null` when that sum is 0. `turns` counts all turns, including user turns.
- **Dimensions** (0–2, no duplicates): `agent`, `model`, `provider`, `effort`, `repo`, `branch`, `tool`, `day` (`YYYY-MM-DD`), `hourOfDay` (0–23), `dayOfWeek` (ISO, 1 = Monday … 7 = Sunday), all in UTC. `subscription`, `profile` and `role` are accepted, grouped as `null` and listed in `unavailable` until phase 3. `repo` groups the stored column, which no adapter fills yet; it is never derived from the working directory. Rows are ordered by dimension values ascending, nulls last; `truncated` is true when more than `limit` (1–10000, default 1000) groups exist.
- **Tools.** Grouping by `tool` counts each turn once per distinct tool it called, so groups overlap and `overlapping` is `true`; turns without tools form the `null` group. A `tool` filter without tool grouping selects turns that did (`in`) or did not (`notIn`) call any listed tool, without duplicating them.
- **Filters** (at most 10, combined with AND): `{ dimension, op: "in" | "notIn", values }` with 1–50 non-empty strings. Values are compared with the dimension's text form (`"23"` for `hourOfDay`) and always bound as parameters. `notIn` keeps `null` groups; unavailable dimensions behave as `null`.
- **Range.** `from` and `to` are required and follow the Summary rules: ISO timestamps with timezone, millisecond precision at most, `from < to`, at most 366 UTC days, selecting turns by timestamp in `[from, to)`.
- Unknown or extra fields, invalid values, malformed JSON and bodies above 64 KiB return 400 with exactly `{"error":"invalid explorer query"}` before any database access. Non-JSON content returns 415, hostile browser Origins 403, non-local Hosts 403. Unsafe aggregates or database failures return 500 with exactly `{"error":"explorer unavailable"}`.

#### Saved views: `GET /api/views`, `PUT /api/views/:id`, `DELETE /api/views/:id`

A saved view (`omt.saved-view/1`) stores the query without `from`/`to` plus a `range` (`last7Days`, `last30Days`, `last90Days`, `last365Days` or `{ "from", "to" }`), a `chart` (`type`: `bar`, `barStacked`, `barGrouped`, `line`, `area`, `heatmap`, `treemap`, `sankey`, `scatter`; `encoding` hints that name query fields) and the chart `spec`: Vega-Lite, or Vega for `treemap` and `sankey`. Specs never embed data or URLs: rows are injected at render time from the named `table` dataset.

- Presets live in `data/views/*.json`, are read-only and use i18n keys for `name` and `description`. User views live in `${XDG_DATA_HOME:-~/.local/share}/one-more-token/views/<id>.json`, next to the default database and independent of `--db`.
- `GET /api/views` returns `{ views, invalid }`: presets then user views, each with `origin: "preset" | "user"`. Unreadable, invalid, symlinked or misnamed user files are listed in `invalid` as `{ id }` without breaking the list.
- `PUT /api/views/:id` creates or replaces a user view and returns it. `id` matches `^[a-z0-9-]{1,64}$` and must equal the body `id`. The file is written atomically (temporary file, then rename) with mode 0600 in a 0700 directory, at most 256 KB. Invalid ids or bodies return 400 `{"error":"invalid view"}`, preset ids 403 `{"error":"preset views are read-only"}`, and a symlinked views directory or file 409 `{"error":"unsafe view storage"}`, with nothing written. Symlinks are never followed.
- `DELETE /api/views/:id` removes a user view (204); a missing view returns 404, a preset 403. Writes are serialized, and share the Host guard, Origin check and JSON requirement of the other write endpoints.

### Sessions API

The Session view backend (spec §7.1): metrics only, no message content. Both endpoints read through the `withDatabase` queue, never mutate data, sit behind the Host guard and disable HTTP caching. Types: `SessionList` and `SessionDetail` in `apps/cli/src/sessions/contract.ts`.

#### `GET /api/sessions?from&to&agent&limit`

- Lists sessions with at least one turn in `[from, to)`. `from`/`to` follow the Summary rules exactly (both or neither; default the rolling seven days). `agent` is optional (`claude-code`, `gentle-shell`, `pi`, `opencode`); `limit` is an integer 1–500 (default 100). Repeated, unknown-agent or invalid values return 400 `{"error":"invalid sessions query"}` before any database read.
- Each item: `id`, `agent`, `cwd` (last path segment only; the full path is never returned), `branch`, `startedAt`, `endedAt`, `parentId`, `turns`, `usageTurns`, `tokens` (four categories and `total`), `costs.reported`/`costs.computed` as known-only sums with `known`/`unknown` counts (computed cost is known only when priced with the current catalog, as in the Summary), `compactions` and `children` (stored sessions whose parent is this one). Counts, tokens and costs cover only the session's turns inside the period.
- Ordered newest started first (then by id); `truncated` is true when more than `limit` sessions match. `pricing` gives the catalog `basis` and `observedAt`.

#### `GET /api/sessions/:id`

- `id` must be a stored record id (`<sha256>:session:<sha256>`, lowercase hex); anything else returns 400 `{"error":"invalid session id"}` before any database read, and an unknown id returns 404 `{"error":"session not found"}`.
- Returns `session` (the list item shape, with stats over every turn of the session), `turns` in `idx` order (`idx`, `role`, `ts`, `model`, `provider`, `effort`, `isCompaction`, `tokens` or `null` without usage, `contextTokens`, per-turn `costs.reported`/`costs.computed` or `null` when unknown, and `tools` with `tool`, `status`, `durationMs`), `parent` (`{ id, agent }`, `agent` null when the parent was never ingested), `children` (`id`, `agent`, `startedAt` and their stats) and `commits` the session's turns are attributed to (`repo` name, short `sha`, `subject`, `authoredAt`, `additions`, `deletions`, and `tokens` of this session's turns), one per sha, oldest first.
- `contextTokens` = input + cache read + cache write tokens: the prompt the model received according to reported usage, `null` when the turn has no usage. The UI plots it as an estimate, with compaction turns marked, and lists the associated commits with their +/− line counts (diffs themselves are not stored).
- Unsafe aggregates or database failures on either endpoint return 500 `{"error":"sessions unavailable"}`.

### Subscriptions, quotas and calibrations

Quota is attributed by subscription, not by agent (spec §4, §5): several agents can drain the same plan. Plans and their limits live in `data/subscriptions.json`; which plans **you** pay for lives in a local file, never in the repository: `${XDG_CONFIG_HOME:-~/.config}/one-more-token/subscriptions.json`.

```json
{
  "version": 1,
  "subscriptions": [
    { "id": "claude-pro", "planId": "claude-pro", "match": [{ "provider": "claude-bridge" }, { "provider": "anthropic", "agent": "claude-code" }] },
    { "id": "chatgpt-plus", "planId": "chatgpt-plus", "match": [{ "provider": "openai-codex" }] },
    { "id": "opencode-go", "planId": "opencode-go", "startedAt": "2026-10-01", "match": [{ "provider": "opencode-go" }] }
  ]
}
```

- `planId` must exist in `data/subscriptions.json`; `label`, `startedAt` and `endedAt` (inclusive ISO dates) are optional. Each `match` rule names a turn `provider` and optionally an `agent`. A turn belongs to the first subscription, in file order, with a matching rule inside its dates; turns without a match count as pay-as-you-go API usage.
- Attribution is computed at query time, so editing the file never needs a re-ingest. A missing file means no subscriptions; an invalid one is reported and ignored.
- Calibrations are the % you read in each provider console (Claude `/usage`, Codex `/status`, the OpenCode Go dashboard). Enter them in the Burn rate view; they are stored in `${XDG_DATA_HOME:-~/.local/share}/one-more-token/calibrations.json` (mode 0600, written atomically, never through a symlink and never over a file that fails validation), since nothing else can rebuild them.
- Codex readings are added automatically: every Codex `token_count` event carries the `rate_limits` Codex shows in `/status` (5 h and weekly %, with their reset time). They are stored at ingest in the database, origin `codex`, rewritten whenever their rollout changes and never written to `calibrations.json`. A reading counts for the subscription whose `match` rules cover provider `openai` and agent `codex` on that date (for example ChatGPT Plus with `{ "provider": "openai", "agent": "codex" }`); readings no subscription matches are ignored. Codex repeats them on every response, so only the latest reading of each window (before it resets) is used and listed. They sit next to your manual readings, marked with their origin, and are read-only.
- Every window figure is an estimate (spec §5.3). Your calibrations set the limit: the median of the limits they imply (usage counted by One More Token divided by the observed %), measured in the same units we count. This also corrects plans with a published limit, such as OpenCode Go, whose agent-reported costs need not match what the provider bills; without readings the published limit is used, and without either the limit is unknown. The deviation shown is leave-one-out (each reading predicted from the others, or from the published limit when it is the only one), as a mean absolute deviation in percentage points. It needs two readings when the limit is estimated, and one when the plan publishes it.

API (Host guard, `Cache-Control: no-store`; writes need a loopback Origin and JSON):

- `GET /api/quotas?from&to` (Summary period rules) returns `config.status` (`ok` | `missing` | `invalid`), `calibrations.status` (`ok` | `invalid`) and, per subscription, windows with usage, limit and its source (`calibrated` | `plan` | `unknown`, in that order of preference), estimated %, reset, pace projection, over-limit usage, calibration deviation and the extracted API-equivalent value. Computed cost follows the Summary's current-pricing rule. Errors: 400 `invalid quotas period`, 500 `quotas unavailable`.
- `GET /api/calibrations`, `POST /api/calibrations` (`subscriptionId`, `windowKind` of that plan, `observedPct` 0–100, `observedAt` not in the future, optional `note` ≤ 200 characters; returns 201) and `DELETE /api/calibrations/:id` (204). The list and the quota readings carry `origin` (`manual` | `codex`); Codex readings cannot be deleted (404 `calibration not found`). Errors: 400 `invalid calibration`, 404 `calibration not found`, 409 `unsafe calibration storage`.

### gentle-shell profiles

Profiles (spec §6) are read from `~/.gentle-shell/config/gentle-ai/profiles.json` at ingest time, read-only, keeping only each role's model and effort. Every distinct definition is a versioned snapshot (sha256 of its canonical JSON). Turns are attributed per turn: **exact** when the session recorded a `gentle-pi.session-profile/v1` binding (child sessions inherit it), otherwise **estimated** when the turn's role, model and effort match exactly one profile; ambiguous turns stay unattributed. Roles are `orchestrator` for gentle-shell sessions and the subagent's agent name for child sessions.

`GET /api/profiles?from&to` returns, per profile, cost and tokens total and per session, role and effort breakdowns, subscriptions drained, snapshot versions and exact vs estimated shares, plus the unattributed gentle-shell turns. Errors: 400 `invalid profiles period`, 500 `profiles unavailable`. The Explorer can group by `subscription`, `profile`, `attribution` and `role`.

### Git commits and orphan tokens

After each ingest, every distinct session working directory (a child session without one inherits its parent's) is resolved to its git repository with `git rev-parse --show-toplevel`; directories that are not repositories or no longer exist are skipped. Git runs read-only: no shell, no optional locks, no fetch and no network, and the repositories are never written. Per repository, `git log --branches --numstat` starts one day before its earliest session and keeps only **your** commits (author email equal to that repository's `git config user.email`): sha, author date, subject line, and added/deleted lines (binary files count 0). No author names or emails are stored. Merge commits are not stored; a local merge titled `Merge pull request #N …` assigns PR `N` to the stored commits it brings in (`M^1..M^2`), the earliest merge winning when a later one repeats them. Commits of repositories no longer seen are kept.

Attribution is per turn: each turn goes to your next commit in the same repository, when that commit lands no later than 30 minutes after the session ends (the later of its recorded end and its last turn; a subagent session uses its own end). A session with three commits splits its tokens among them; turns after the last one are **orphan**. It is recomputed in full after every ingest.

`GET /api/git?from&to` (Summary period rules) returns `commits` authored in the period (repository name, short sha, subject, `authoredAt`, additions, deletions, tokens, computed and reported cost, sessions, PR number or null), `pullRequests` aggregated over those commits, and `orphanSessions` with orphan turns in the period (session, agent, repository or null, `startedAt`, orphan tokens and costs, `hadCommit`). Tokens are input + output + cache read + cache write; computed cost follows the Summary's current-pricing rule. Errors: 400 `invalid git period`, 500 `git unavailable`.

The **Git** view (`/git`) shows, for the selected period, the attributed vs orphan tokens, a chart of tokens per commit over time, a commits table and a PR table with tokens per net line (tokens / (additions − deletions), not applicable when the net is zero or negative), and the orphan sessions with a link to each one in the Session view.

### Where your data lives

- The database is a single DuckDB file at `$OMT_DB` if set, otherwise `${XDG_DATA_HOME:-~/.local/share}/one-more-token/omt.duckdb`. Override it per run with `pnpm omt serve --db <path>`.
- The server binds to `127.0.0.1` by default, so it is only reachable from your machine. There is no telemetry.
- Agent session files are only read, never modified.
- Views you save from the Explorer are JSON files in `${XDG_DATA_HOME:-~/.local/share}/one-more-token/views/`.
- Quota calibrations are in `${XDG_DATA_HOME:-~/.local/share}/one-more-token/calibrations.json`; your subscriptions in `${XDG_CONFIG_HOME:-~/.config}/one-more-token/subscriptions.json`.

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

# One More Token (`omt`)

Local web dashboard that analyzes usage, cost and subscription quotas of AI coding agents (Claude Code, gentle-shell/Pi, OpenCode, Codex). Everything stays on your machine: no telemetry, source sessions are opened read-only.

## Quick start

```bash
npx one-more-token
```

The single command:

1. Detects the agent session directories on your machine and prints them.
2. Validates the bundled pricing and subscription data.
3. Ingests the local sessions into a DuckDB database
   (`${XDG_DATA_HOME:-~/.local/share}/one-more-token/omt.duckdb`).
4. Serves the dashboard (API + built UI) on `http://127.0.0.1:7317`.
5. Opens the dashboard in your browser.

Press `Ctrl+C` to stop.

## Options

```bash
omt start --port 8080      # different port (0 picks a free one)
omt start --no-open        # do not open the browser
omt start --db ~/omt.duckdb
omt serve                  # serve without ingesting
omt ingest                 # ask a running server to ingest again
```

## Privacy

- Sessions of your agents are read-only; nothing is written to them.
- The database and reports stay under your XDG data/config directories.
- Alerts (optional) only leave the machine if you configure a Telegram channel.

## Development

This package is built from the One More Token monorepo: `pnpm check` (typecheck + lint + tests), `pnpm --filter @omt/cli build` produces the publishable bundle (`dist/`, `web-dist/`, `data/`, `migrations/`).

License: MIT.

<h1 align="center">One More Token</h1>

<p align="center"><em>Just one more token.</em></p>

<p align="center">
  A local dashboard to explore how you use AI coding agents: tokens, cost, subscription quotas and the agent profiles behind them.
</p>

> **Status:** phase 0 (foundation). The schema, design system and server skeleton are in place; session ingestion arrives in phase 1, so there is no data to explore yet.

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

`pnpm omt ingest` (reading your local agent sessions) arrives in phase 1. Run `pnpm omt --help` for every command and option.

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

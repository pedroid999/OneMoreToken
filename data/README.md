# data/

Prices, quota limits and design tokens are data, not code (spec §4, §8.2). Edit them here; never hardcode them.

| File | Contents | Schema |
|---|---|---|
| `pricing.json` | Price per million tokens by model and provider, with `validFrom` / `validTo` dates | `PricingFileSchema` in `packages/core/src/data/files.ts` |
| `subscriptions.json` | Plans, their quota windows and limits (`usd`, `tokens` or `estimated`). Which plans you pay for lives in your local config (see the README) | `SubscriptionsFileSchema` in the same file |
| `theme/` | Design tokens for the Kanagawa themes | see `theme/README.md` |
| `views/` | Preset Explorer views: query, chart type and Vega-Lite (or Vega) spec, one file per view named `<id>.json` | `SavedViewSchema` in `packages/core/src/data/views.ts` |

`pnpm check` validates every file against its schema.

Preset views are versioned and read-only: `name` and `description` are i18n keys (`explorer.presets.<key>.name`), specs never embed data or URLs, and they contain no personal data. Views saved from the UI live outside the repository (see the README).

## Pricing policy (spec §4)

The bundled catalog is a **current-rate API-equivalent estimate**, observed on **2026-10-21**, not a historical bill or a subscription charge. Reported cost remains separate and unchanged, including reported zero.

- `basis: "current-reference"` requires an ISO `observedAt` date. Lookup uses that date even for older turns; `validFrom` records the observation date, never a fabricated historical effective date. Entries must cover `observedAt`.
- Version 1 files without policy metadata (or with `basis: "historical"`) retain inclusive UTC event-date lookup. `observedAt` is only valid with current-reference policy.
- Exact provider/model pairs only: `anthropic` and `claude-bridge` / `claude-opus-5-5`, and `openai-codex` / `gpt-6.1-sol`. Bridge/Codex entries are API reference equivalents, not subscription rates. Unknown identifiers, including `claude-opus-5-5[1m]`, remain null; no suffix stripping or inferred aliases.
- Standard global rates only. Fast, geography, batch, negotiated discounts and other modifiers cannot be inferred and are excluded. The catalog does not establish actual billing accuracy.

### Rates and provenance

All prices below are USD per million tokens. Each JSON entry carries its public source URLs.

| Exact model | Input | Output | Cache read | Short write | Long write |
|---|---:|---:|---:|---:|---:|
| `claude-opus-5-5` | 4 | 20 | 0.20 | 5 (5 min) | 8 (1 h) |
| `gpt-6.1-sol`, prompt ≤272000 | 2 | 10 | 0.10 | 2.50 (30 min) | 5 (12 h) |
| `gpt-6.1-sol`, prompt >272000 | 4 | 15 | 0.20 | 5 (30 min) | 10 (12 h) |

Anthropic: [model and 1M standard context](https://platform.claude.com/docs/en/models/opus-5-5/overview), [pricing](https://platform.claude.com/docs/en/about-claude/pricing).
OpenAI: [exact model](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [pricing](https://developers.openai.com/api/docs/pricing).

`longContext.inputTokenThreshold` selects the entire request's alternate rate set only above the threshold. Prompt size is original input + cache read + aggregate cache write; output is excluded. No tier or rate is hardcoded in the calculator.

`cacheWriteLongPerMTok` is the provider's long-TTL write rate. Claude's observed `ephemeral_1h_input_tokens` is a subset of aggregate cache creation: it is weighted at the long rate, with remaining writes at the ordinary rate, never added twice. Invalid counts are rejected safely; a positive one-hour count without a long rate yields unknown computed cost. Repeated blocks retain observed TTL detail. Pi has no observed long-write metadata, so unspecified TTL uses the short-TTL rate as an estimate (including OpenAI); the presence of a long price alone does not imply long writes.

### Repricing and subscriptions

Ingestion hashes schema-normalized pricing JSON separately from source content and adapter version. A changed pricing hash reparses and atomically replaces the source snapshot and checkpoint; a failure rolls back both. Legacy null hashes reparse once. JSON whitespace/object key order does not invalidate the checkpoint. Source files remain read-only.

`subscriptions.json` must be reviewed periodically (spec §5.1); update `reviewedAt` when you do. `monthlyPriceUsd: null` means the price is not verified yet.

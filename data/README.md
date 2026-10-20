# data/

Prices, quota limits and design tokens are data, not code (spec §4, §8.2). Edit them here; never hardcode them.

| File | Contents | Schema |
|---|---|---|
| `pricing.json` | Price per million tokens by model and provider, with `validFrom` / `validTo` dates | `PricingFileSchema` in `packages/core/src/data/files.ts` |
| `subscriptions.json` | Plans, their quota windows and limits (`usd`, `tokens` or `estimated`) | `SubscriptionsFileSchema` in the same file |
| `theme/` | Design tokens for the Kanagawa themes | see `theme/README.md` |

`pnpm check` validates every file against its schema.

- `pricing.json` starts empty: entries are added with the first adapters (phase 1), each checked against the provider's public pricing page.
- `subscriptions.json` must be reviewed periodically (spec §5.1); update `reviewedAt` when you do. `monthlyPriceUsd: null` means the price is not verified yet.

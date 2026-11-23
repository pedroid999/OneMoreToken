# Nan Builders (NaN Gentle) subscription

Support the user's NaN Gentle subscription (nan.builders, in collaboration with Gentle
Programming) in quota status, attributed exactly per model.

## Specs

S1: The Dashboard shows: "DeepSeek V4-Flash (4.1-1017 version)… 219.4M / 1.0B this period …
Allowance per billing period: 1,000M · resets on Dec 3, 08:38 (UTC)" — DeepSeek V4 Flash has a
1,000,000,000-token monthly billing-period allowance.
S2: The Dashboard shows: "GLM 5.3 Flash… 35.7M / 500.0M this period / your tier … Allowance per
billing period: 500M · resets on Dec 3, 08:38 (UTC)" — GLM 5.3 Flash has a 500,000,000-token
monthly billing-period allowance. Sources: nan.builders/terms (since 2026-11-10 inference is
measured in credits "except on the Gentle plan"), gentlemanprogramming.com (Gentle plan:
"DeepSeek V4 Flash 1,000M tokens · GLM 5.3 Flash 500M tokens. Each allowance is per billing
cycle").
S3: There is no five-hour or weekly window on this plan; only the monthly billing period.
S4: "modelado exacto por modelo" (user answer): each model allowance is its own subscription in
the quota status, so the panel shows the same split as the NaN dashboard.
S5: Subscription rules must be able to match by model in addition to provider and agent, so
turns calling `deepseek-v4-flash` land in one subscription and `glm5.3-flash` in the other;
schema changes only through a new numbered migration (AGENTS.md rule 6).
S6: Prices and limits are data (AGENTS.md rule 5): plan and allowances live in
`data/subscriptions.json`; NaN does not publish per-token prices, so no pricing entries are
invented for these models.
S7: Verified in the local DuckDB (user-consented, read-only): NaN turns store `provider = 'nan'`
with models exactly `deepseek-v4-flash` (4,022 turns) and `glm5.3-flash` (633 turns) — the same
ids as https://nan.builders/docs/models. Rules must use these exact strings.

## Tasks

T1 (S5,S7): Migration `011_subscription_model.sql` (migrations already run 001-010, L6): add an optional `model` column to
`subscription_rules` and rebuild the `turn_subscriptions` view so a rule matches when
`r.model IS NULL OR r.model = t.model` (keeping provider/agent semantics unchanged). — commit:
`feat(core): match subscription rules by model`
T2 (S5): `packages/core/src/subscriptions/config.ts`: accept and validate optional `model` in
`match` entries (non-empty string); unit tests. — commit: with T1
T3 (S5,S7): Engine/sync passes the model rule through (attribution tests: nan + deepseek lands
in one subscription, nan + glm in the other, other providers unaffected). — commit: with T1
T4 (S1,S2,S3,S6): `data/subscriptions.json`: plans `nan-gentle-deepseek` (monthly, limit unit
`tokens`, 1000000000) and `nan-gentle-glm53-flash` (monthly, `tokens`, 500000000), provider
`nan`; the plan costs 20 EUR/month (user, L3) — record the price as the user gave it and note
the currency in README, never invent a USD conversion. — commit: `feat(data): nan gentle plans`
T5 (S4): `docs/spec.md` §5.1 row for the NaN Gentle plan (Spanish); README mention. — commit:
`docs: nan gentle subscription`
T6 (S4,S7): Register in the user's `~/.config/one-more-token/subscriptions.json` (outside the
repo; needs explicit consent for that write): `{ "id": "nan-gentle-deepseek", "planId":
"nan-gentle-deepseek", "match": [{ "provider": "nan", "model": "deepseek-v4-flash" }] }` and the
glm5.3-flash counterpart. Then re-ingest/serve and confirm both panels appear in quota status. —
no commit (user file)

## Log

L1 (verbatim): "a qui tienes la imagen del dashboard de nan builders, es la subs en colaboración
con gentle programming investiga sobre ella y deduce como va de las investigaciones y de esta
imagen" — with the NaN dashboard image (S1/S2/S3 evidence).
L2: User chose "Exacto por modelo" for the modeling question.
L3: DuckDB verification (S7 evidence) and user price answer: 20 euros per month.
L4: Price decision: the user price is in EUR; record it as given instead of inventing a USD
conversion, and make the currency explicit in the label/README.
L5: "Sí, consúltada" (user answer): read-only consent to open the local DuckDB for the S7
verification; granted.
L6: The migrations directory already contains 001-010 (006 is taken), so the new migration is
numbered 011, not 006 as originally planned.

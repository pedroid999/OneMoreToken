# Phase 3 — Quotas, calibration and gentle-shell profiles

Implements `docs/spec.md` §12 Phase 3 on `feat/phase-3-quotas`, branched from `main` (`84d6efd`, Phase 2 merged via #6 → develop and #7 → main).
Product intent remains in the Spanish spec; quoted requirements below are authoritative. Profile scope is the §6 core only (L4).

## Specs

- S1 (§12): "Cuotas y calibración, perfiles de gentle-shell"; closure: "Desviación media frente a calibraciones documentada".
- S2 (§5.1): "Claude (Pro/Max) | 5 horas y semanal | No pública en tokens: estimación + calibración"; "OpenCode Go | 5 h: 12 $ · semanal: 30 $ · mensual: 60 $ | Dólares de uso"; "Los valores de límites viven en `data/subscriptions.json` y deben revisarse periódicamente." Plus ChatGPT Plus for `openai-codex` (L3).
- S3 (§5.2): "Línea de tiempo de ventanas de 5 h, cada una coloreada por % de consumo estimado."; "Medidores semanal y mensual con fecha de reinicio."; "Proyección de ritmo: hora estimada a la que se alcanzará el límite al ritmo actual."; "Valor extraído: equivalente en precio API frente a lo pagado por la suscripción."; "Registro de uso por encima del límite (p. ej., fallback de OpenCode Go a saldo de pago)."
- S4 (§5.3): "Toda cifra de ventana se marca visualmente como estimada."; "El usuario puede introducir a mano el % que ve en la consola del proveedor; One More Token usa esas lecturas para ajustar su estimación y muestra la desviación histórica."
- S5 (§4): "Atribución de cuota por suscripción, no por agente. Varios agentes pueden consumir la misma cuota (p. ej., OpenCode y gentle-shell usando OpenCode Go)."; "Precios y límites son datos, no código". Attribution comes from a local per-provider config (L2).
- S6 (§6): "Un perfil define el enrutado completo: modelo, proveedor y esfuerzo del orquestador y de cada rol de agente."
- S7 (§6.1, core per L4): "Coste y tokens por perfil: total, por sesión"; "Desglose por rol dentro del perfil (orquestador, explorer, writers, verifier, reviewers)."; "Esfuerzo como dimensión independiente (mismo modelo, distinto esfuerzo)."; "Qué cuotas de suscripción drena cada perfil."
- S8 (§6.2): "Por turno, no por sesión: aplicar un perfil cambia el modelo de la sesión en vivo."; "Definiciones versionadas: un perfil puede editarse; cada turno referencia la instantánea vigente."; "Atribución exacta vs estimada: desde la v4.1 el perfil se vincula a la sesión. Para sesiones anteriores, inferir el perfil cruzando modelos por rol con las instantáneas, y marcarlo como estimado."
- S9 (§7.1): "Burn rate: ventanas 5 h / semanal / mensual por suscripción, proyección de ritmo y calibraciones."; "Perfiles: comparativas de §6."; "Resumen: … estado de cuotas".
- S10 (§7.2): dimensions "suscripción, perfil, rol, esfuerzo" become available in the Explorer.
- S11 (§3, §10, AGENTS hard rules): "Solo lectura. Nunca escribir ni bloquear ficheros de los agentes."; "Todo se ejecuta y almacena en local. Sin telemetría."; adapters validate with Zod and have snapshot tests over anonymized fixtures; schema changes only through a new numbered migration; UI uses tokens/base components and es/en i18n keys.

## Design

- D1 Subscriptions: plans stay in `data/subscriptions.json`; the user's accounts live in `${XDG_CONFIG_HOME:-~/.config}/one-more-token/subscriptions.json` (`{version:1, subscriptions:[{id, planId, label?, startedAt, endedAt?, match:[{provider, agent?}]}]}`), synced into `subscriptions` + rule rows; a turn belongs to the first subscription whose rule matches its provider (and agent, when set) inside the date range; no match = pay-as-you-go API. Attribution is derived at query time, so editing the config never needs a re-ingest.
- D2 Calibrations: source of truth is `${XDG_DATA_HOME:-~/.local/share}/one-more-token/calibrations.json` (cannot be rebuilt from agent data), validated with Zod, written atomically by the server, mirrored into `calibrations`.
- D3 Usage unit: `usd` plans use reported cost when present, else computed cost; `estimated` plans use computed API-equivalent cost as the consumption proxy. 5 h and weekly windows open at the first attributed turn after the previous window expired; monthly windows anchor on the subscription `startedAt` day. Estimated limit = median of limits implied by calibrations (`used_at_t / observed_pct`); deviation = leave-one-out predicted % minus observed %, reported as mean absolute deviation in percentage points.
- D4 Subagents: ingest `~/.gentle-shell/agent/gentle-agents/sessions/*.jsonl` as child sessions; read only metadata keys (`id`, `agent`, `parentSessionId`, `model`, `thinking`, `sessionPath`, timestamps) from `gentle-agents/tasks/*.json`, never `prompt`/`result`. Role = task `agent`; parent sessions are `orchestrator`.
- D5 Profiles: snapshot `~/.gentle-shell/config/gentle-ai/profiles.json` read-only at ingest (hash of canonical per-profile JSON). `custom` entries `gentle-pi.session-profile/v1` (`kind: bind|clear`, `modelProfiles`) give exact attribution; otherwise infer per turn by matching role → `provider/model` + effort against snapshots, unique match = estimated, ambiguous = unattributed.

## Tasks

- [ ] T1 — S2,S5,S11: migration 005 (subscription rules), ChatGPT Plus plan, local subscriptions config (schema, loader, sync), query-time attribution; route: inline; Risk item 1 (migration). Commit: —
- [ ] T2 — S3,S4,S11: calibrations file store + API (create/delete/list), Zod, atomic writes; route: inline; Risk item 1 (user data that cannot be rebuilt). Commit: —
- [ ] T3 — S2-S4: pure quota engine (windows, usage, estimated limit, %, reset, pace projection, over-limit, extracted value, deviation) + `/api/quotas`; route: inline or worker by context. Commit: —
- [ ] T4 — S7,S8,S11: subagent sessions ingestion (D4) with fixtures and snapshots; route: worker candidate. Commit: —
- [ ] T5 — S6-S8,S11: profiles snapshot + exact/estimated attribution (D5), `/api/profiles`, Explorer dimensions subscription/profile/role (S10); route: worker candidate. Commit: —
- [ ] T6 — S3,S4,S9,S11: Burn rate view (timeline, gauges, projection, value, over-limit, calibration form + deviation), Summary quota status; route: worker candidate. Commit: —
- [ ] T7 — S7,S9,S11: Profiles view; route: worker candidate. Commit: —
- [ ] T8 — S1: docs (README config, data/README, spec §3 Codex → Phase 4), real-data acceptance with user calibrations, mean deviation documented here. Commit: —

## Log

- L1 (user request): "ADelante" — answering "¿Empezamos la fase 3? Si te parece, creo `feat/phase-3-quotas` desde `main` y empiezo por leer las secciones de la spec sobre cuotas, calibración y perfiles para preparar el documento de la fase."
- L2 (user decisions): read permission "Sí, solo lectura" for `~/.gentle-shell/`, `~/.pi/agent/sessions/`, `~/.claude/projects/` and the OpenCode DB (no credentials, originals untouched, real metrics only in an isolated temporary DB, nothing committed); subscription attribution "Config local por proveedor"; plans: "Tengo claude pro, openai y opencode go".
- L3 (user decisions): OpenAI plan "ChatGPT Plus"; profile scope "Núcleo (recomendado)"; Codex CLI "Fase 4 (§12)" — fix §3 in the spec.
- L4 (scope): deferred from §6: per-commit / per-feature metrics (needs Git, Phase 4), review quality, task-class grouping and experiment mode (§6.3).
- L5 (evidence): profiles in `~/.gentle-shell/config/gentle-ai/profiles.json` (`kind: gentle-pi.agent_model_profiles`, `version: 1`, `profiles.<name>.<role>.{model: "provider/id", thinking}`, `active`). `gentle-pi.session-profile/v1` custom entries exist in gentle-pi 4.5.0 code but 0 local sessions contain one, so real attribution is estimated for now. Subagent transcripts live in `~/.gentle-shell/agent/gentle-agents/sessions/` (28 files, Pi v3 format) and are not ingested today; task records in `gentle-agents/tasks/*.json` hold `agent`, `parentSessionId`, `model`, `thinking`, `sessionPath`, `tokens`, `cost`. Subagents are separate processes, so parent usage does not include theirs. Provider ids observed: `claude-bridge`, `openai-codex`, `opencode-go` (Pi); OpenCode DB assistant providers `opencode-go` 3222, `llama.cpp` 1014, `opencode` 162, `openai` 67, `ollama` 8.

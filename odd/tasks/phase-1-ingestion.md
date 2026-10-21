# Phase 1 — Local session ingestion

Implements `docs/spec.md` §12 Phase 1 on `feat/phase-1-ingestion`, based on `1957c53`.
Product intent remains in the Spanish spec; quoted requirements below are authoritative.

## Specs

- S1 (§12): "Adaptadores Claude Code + gentle-shell/Pi, CLI `ingest`, vista Resumen"; closure: "Ingesta real de una semana de sesiones sin incidencias críticas".
- S2 (§3): "Solo lectura. Nunca escribir ni bloquear ficheros de los agentes. Para SQLite, abrir en modo solo lectura."
- S3 (§3): "Ingesta incremental. Recordar qué se ha ingerido (por fichero + offset/hash, o por id de sesión) para no reprocesar."; "Idempotencia. Ingerir dos veces lo mismo no duplica filas."
- S4 (§3): "Tolerancia a errores. Una línea o sesión corrupta se registra como incidencia y no detiene la ingesta."; "Versión del formato. Cada sesión guarda qué versión de adaptador/formato la interpretó."
- S5 (§3): "cada adaptador debe validar su salida con Zod y tener fixtures reales anonimizadas."
- S6 (§4): "Coste: si el agente reporta coste, se guarda tal cual; además siempre se calcula con `pricing` para poder comparar. Se muestran ambos cuando difieren."; "Precios y límites son datos, no código: ficheros JSON versionados con fechas de vigencia."
- S7 (§7.1): "Resumen: tokens (M), coste y sesiones del periodo; estado de cuotas; tendencias." (§7.2): "Unidades por defecto en millones de tokens (M) con un decimal."
- S8 (§10): "Todo se ejecuta y almacena en local. Sin telemetría."; "Redacción de secretos al ingerir (claves API, tokens, variables de entorno sensibles) antes de guardar texto."; "Opción para ingerir solo métricas, sin contenido de mensajes."
- S9 (§11.1): "La ingesta (incluido el modo `watch`) corre dentro del mismo proceso que el servidor para respetar el único escritor de DuckDB."
- S10 (§11.3): "La verificación única es `pnpm check` (tipos, lint y tests). Nada se da por terminado si falla."; "Cada adaptador tiene tests de snapshot: fixture de entrada → salida normalizada esperada."; "Nunca modificar ficheros de los agentes fuente; los tests usan solo fixtures."
- S11 (§8.5): "Ningún texto visible escrito en el código. Todo pasa por claves de traducción en inglés"; "Cambio en caliente, sin recargar la página y conservando la vista y los filtros."

## Tasks

- [ ] T1 — S3-S6,S8: shared normalized adapter contract, incremental checkpoint migration, data-driven pricing lookup, ingestion persistence helpers; route: worker (context backstop); implementation commit: ecec050; check: 230 tests pass; independent verification pending (Risk item 1: source snapshot replacement).
- [ ] T2 — S2-S6,S8,S10: Claude Code adapter with anonymized observed-shape fixtures and snapshots, deduplicate repeated assistant blocks by message id; route: worker; commit: _.
- [ ] T3 — S2-S6,S8,S10: shared Pi v3 parser and gentle-shell/Pi source wrappers, fixtures and snapshots; route: worker; commit: _.
- [ ] T4 — S1-S4,S8-S10: single-writer server ingestion service, localhost API and CLI client, read-only discovery and incremental append/replace handling; help + README; route: worker; commit: _.
- [ ] T5 — S1,S6-S7,S11: period summary API and UI with totals, trends, reported/computed cost distinction, honest quota-unavailable state; route: worker; commit: _.
- [ ] T6 — S1-S11: integrated checks, browser functional check, read-only week-of-data metrics-only ingestion and repeated-run evidence, final review/assessment per work unit; route: parent + verifier when required; commit: _.

## Log

- L1 (user): "Ya la probé, continua" — after Phase 0 testing; authorized continuation is Phase 1.
- L2 (permission): "Sí, inspección e ingesta de prueba" — read sessions under `/Users/pedro.nieto/.claude/projects/`, `/Users/pedro.nieto/.gentle-shell/agent/sessions/`, `/Users/pedro.nieto/.pi/agent/sessions/`; profile investigation under `/Users/pedro.nieto/.gentle-shell/gentle-ai/` and `/Users/pedro.nieto/.gentle-shell/agent/gentle-ai/`. No credentials; originals remain untouched; do not publish real data. Real check stores metrics in an isolated local test DB, not fixtures.
- L3 (evidence): Claude assistant outer rows can repeat the same `message.id` with identical usage: never sum blocks as distinct usage. Usage has separate input/output/cache creation/cache read token fields. `cost-state` contains cumulative snapshots, not additive turn costs. Tools join `tool_use.id` to `tool_result.tool_use_id`.
- L4 (evidence): Pi and gentle-shell session headers use version 3, with `id`, `timestamp`, `cwd`; events have `id`, `parentId`, `timestamp`. Assistant usage is per message: `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, `cost.{input,output,cacheRead,cacheWrite,total}`. `claude-bridge` can report zero costs with nonzero usage; preserve reported zero but do not label it free. Model/provider and thinking-level changes exist. Tools join `toolCall.id` with `toolResult.toolCallId`.
- L5 (decision): Phase 1 stores metrics only (no message content, titles, tool arguments, results, or raw parse errors). Fixture snippets are reconstructed from verified structural shapes with synthetic text and paths. Profiles, quota reconstruction/calibration, and complete subagent attribution remain Phase 3 work; sampled metadata did not establish reliable profile attribution. Do not guess or double-count subagent usage.
- L7 (slice boundary): ecec050 is the isolated core-ingestion unit (~660 added lines including tests), above the ~400-line guideline because the atomic snapshot contract and its transaction tests belong together. Native assessment/review must take this core unit alone, not the accumulated branch.
- L6 (constraint): memory tools are not currently callable; the feature file is the continuity source until an Engram mirror is available.

# Phase 2 — Explorer, Session view and OpenCode

Implements `docs/spec.md` §12 Phase 2 on `feat/phase-2-explorer`, branched from `main` (`7bb78c7`, Phase 1 merged via #3 → develop and #4 → main).
Product intent remains in the Spanish spec; quoted requirements below are authoritative.

## Specs

- S1 (§12): "Explorador pivot, vista Sesión, adaptador OpenCode (SQLite + legacy)"; closure: "Al menos 5 vistas guardadas útiles".
- S2 (§3): "OpenCode (actual) | `${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db` | SQLite"; "OpenCode (legacy) | `~/.local/share/opencode/storage/` (`session/`, `message/`, `part/`, `session_diff/`) | JSON sueltos".
- S3 (§3): "Solo lectura. Nunca escribir ni bloquear ficheros de los agentes. Para SQLite, abrir en modo solo lectura."; "Ingesta incremental. Recordar qué se ha ingerido (por fichero + offset/hash, o por id de sesión) para no reprocesar."; "Idempotencia. Ingerir dos veces lo mismo no duplica filas."; "Tolerancia a errores. Una línea o sesión corrupta se registra como incidencia y no detiene la ingesta."; "Versión del formato. Cada sesión guarda qué versión de adaptador/formato la interpretó."
- S4 (§3): "cada adaptador debe validar su salida con Zod y tener fixtures reales anonimizadas." (§11.3): "Cada adaptador tiene tests de snapshot: fixture de entrada → salida normalizada esperada."
- S5 (§4): "Coste: si el agente reporta coste, se guarda tal cual; además siempre se calcula con `pricing` para poder comparar. Se muestran ambos cuando difieren."
- S6 (§7.2): "Métricas: input, output, cache read, cache write, total, coste calculado, coste reportado, ratio de acierto de caché, nº de turnos, nº de sesiones."
- S7 (§7.2): "Dimensiones: agente, modelo, proveedor, suscripción, perfil, rol, esfuerzo, repo, rama, herramienta, día, hora del día, día de la semana."
- S8 (§7.2): "Gráficos: barras (apiladas o agrupadas), líneas, área, heatmap, treemap, sankey, dispersión."
- S9 (§7.2): "Filtros combinables y rango temporal libre."; "Toda vista configurada se puede guardar como especificación Vega-Lite + consulta, en un fichero JSON."; "Unidades por defecto en millones de tokens (M) con un decimal."
- S10 (§7.1): "Sesión: detalle turno a turno, curva de contexto con compactaciones, herramientas, subagentes y diff de commits asociados."
- S11 (§8.2, §8.5): "UI uses design tokens and base components only"; "Ningún texto visible escrito en el código. Todo pasa por claves de traducción en inglés"; "Cambio en caliente, sin recargar la página y conservando la vista y los filtros."; (§8.2) "«Guardar vista» → «Vista guardada»".
- S12 (§10, §11.1): "Todo se ejecuta y almacena en local. Sin telemetría."; "Opción para ingerir solo métricas, sin contenido de mensajes."; "La ingesta (incluido el modo `watch`) corre dentro del mismo proceso que el servidor para respetar el único escritor de DuckDB."
- S13 (L2 decision): five versioned preset views in `data/views/*.json` (no personal data) plus views saved from the UI in `${XDG_DATA_HOME:-~/.local/share}/one-more-token/views/`.

## Tasks

- [x] T1 — S3,S10: migration 004 (`sessions.parent_session_id`, `turns.is_compaction`), batch schema/persistence support, tests; route: inline; Risk item 1. RED observed (migrate + ingest), `pnpm check` 344 tests pass; commit: see Log L7.
- [ ] T2 — S2-S5,S12: OpenCode adapter: pure parser over a canonical per-session document, read-only SQLite reader (`node:sqlite` readOnly) and legacy JSON reader, anonymized fixtures + snapshots, incremental per session, wired into ingest; route: inline.
- [ ] T3 — S10: compaction markers for Claude Code and Pi/gentle-shell adapters (version bump, snapshots); route: inline.
- [ ] T4 — S6-S9,S13: Explorer backend: whitelisted pivot query builder, filters, time range, saved views store (presets + local), API; route: inline; Risk item 1/2 (query construction, local file writes).
- [ ] T5 — S6-S9,S11,S13: Explorer UI with Vega-Lite (Vega for treemap/sankey), filters, save view, five presets; route: inline.
- [ ] T6 — S10,S11: Session view API + UI: turn-by-turn, context curve with compactions, tools, child sessions; commit diff deferred to Phase 4; route: inline.
- [ ] T7 — S1-S13: integrated `pnpm check`, read-only real OpenCode ingestion with repeat run, browser check, five useful saved views; route: parent + verifier where escalated.

## Log

- L1 (user request): "Seguimos" → choice "Subir Fase 1 y empezar Fase 2".
- L2 (user decision): "5 predefinidas + las tuyas en local (recomendado)" — 5 vistas versionadas en data/views/*.json (sin datos personales) y las que guardes desde la UI en ${XDG_DATA_HOME}/one-more-token/views/, junto a la base.
- L3 (scope): §12 Phase 2 lists Explorer, Session and OpenCode only; the router's Agents/Tools "phase 2" placeholders stay upcoming. Subscription/profile/role dimensions show as unavailable until Phase 3. Session commit diff is Phase 4 (Git). Raw SQL stays Phase 4; the pivot only composes whitelisted metrics/dimensions.
- L4 (evidence): OpenCode SQLite (read with `immutable=1`, schema only): tables `session` (id, parent_id, directory, version, time_created/updated, time_compacting, aggregate cost/tokens), `message` (session_id, time_created, JSON `data`: role, modelID, providerID, cost, tokens {input, output, reasoning, cache {read, write}}, time, finish, agent, mode, variant), `part` (message_id, session_id, JSON `data.type`: text, reasoning, tool, step-start, step-finish, patch, file, subtask, compaction). Legacy `storage/message/*/*.json` has the same assistant keys. Times are epoch milliseconds.
- L5 (decision): Vega-Lite has no treemap/sankey; those two charts use Vega specs. Saved views store the chart spec + query JSON either way. Reasoning tokens are billed as output and are added to `output_tokens`.
- L6 (user decision): "Abre un un PR, yo lo mergeo en develop, luego lo haces a main y yo lo mergeo también y solo entonces empezamos la fase 2 que saldrá de main" — done: #3 and #4 merged; branch recreated from `origin/main` 7bb78c7 without upstream.
- L7 (evidence): DuckDB rejects `ADD COLUMN ... NOT NULL` and `SET NOT NULL` over existing rows inside the migration transaction ("Cannot create index with outstanding updates"); `is_compaction` is `DEFAULT false` in SQL and required boolean in the Zod write contract. Adapter versions are unchanged: migrated rows receive exactly the values the adapters now emit (null/false), so no forced re-ingest.

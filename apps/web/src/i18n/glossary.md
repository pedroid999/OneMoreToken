# Glossary / Glosario

Minimum vocabulary so both catalogs name the same concept the same way (spec §8.5). Keys are in English; UI text is sentence case in both languages.

"One More Token" and "Burn rate" are proper names and are never translated.

| English | Español |
|---|---|
| session | sesión |
| turn | turno |
| (quota) window | ventana (de cuota) |
| quota | cuota |
| subscription | suscripción |
| profile | perfil |
| role | rol |
| effort | esfuerzo |
| computed / reported cost | coste calculado / reportado |
| calibration | calibración |
| adapter | adaptador |
| ingest | ingesta (verb: ingerir) |
| saved view | vista guardada |
| estimated | estimado |
| settings | ajustes |
| theme | tema |
| density | densidad |

## Rules

- One action, one name: the button, shortcut, command palette entry and confirmation use the same verb ("Save view" → "View saved" / «Guardar vista» → «Vista guardada»).
- Plurals use `_zero`, `_one` and `_other` keys, never string concatenation.
- Numbers, dates and amounts go through `src/i18n/format.ts` (`Intl`), never through catalog strings.

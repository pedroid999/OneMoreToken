# One More Token — Especificación del proyecto

> *Just one more token.* Panel web local para analizar el uso, el coste y las cuotas de los agentes de código (Claude Code, gentle-shell/Pi, OpenCode y otros).
>
> CLI: `omt`

**Estado:** borrador v0.3 · **Fecha:** 2026-10-16

### Nombre

- **One More Token** es el nombre del producto: el «solo un turno más» de Civilization aplicado a tokens, la sensación de querer volver que persigue la UX (§8).
- **Burn rate** es el nombre de la vista de cuotas y proyección de ritmo (§5 y §7.1). El guiño a «quemar tokens» vive ahí, no en el nombre del producto.
- CLI y paquete: `omt`. Antes de publicar, comprobar que el nombre está libre en npm y GitHub.

---

## 1. Objetivo

One More Token ingiere las sesiones que los agentes de código guardan en local, las normaliza a un esquema común y ofrece un dashboard para explorarlas con libertad: tokens (en millones), coste, ventanas de cuota de las suscripciones, comparativas entre agentes, modelos y perfiles de gentle-shell, y cruces con el historial de git.

El valor diferencial frente a `/gentle:stats` y a los medidores de suscripción de gentle-shell es:

- Una sola vista para **todos** los agentes, no solo Pi/gentle-shell.
- **Histórico** de ventanas de cuota, no solo la ventana actual.
- **Exploración libre**: pivot de métricas × dimensiones × tipo de gráfico, y consola SQL.
- **Cruces** con git, perfiles de gentle-shell y calidad del trabajo (rondas de revisión).

### Open source

El proyecto será **open source**. Por eso README, AGENTS.md, comentarios, commits y documentación técnica van en inglés; esta spec se mantiene en español como documento de intención del autor.

### Fuera de alcance (por ahora)

- Multiusuario, autenticación o despliegue en la nube. Es una herramienta local de un solo usuario.
- Modificar los datos de los agentes. One More Token **solo lee** sus ficheros.

---

## 2. Entorno de desarrollo

### 2.1 Herramientas y modelos

- El desarrollo se hará **principalmente con modelos Claude**.
- El harness principal es **gentle-shell**, siguiendo su flujo **ODD** (Organic Driven Development). Este documento es la spec de referencia: los documentos de feature de ODD deben citarla por sección en lugar de parafrasearla.
- gentle-shell se ejecuta **dentro de herdr** (multiplexor de terminal para agentes, con workspaces, pestañas y paneles, y CLI/socket utilizable por los propios agentes).
- Claude Code puede usarse de forma puntual sobre el mismo repositorio. Las instrucciones para agentes deben servir a ambos (ver §11.2 y §11.3).

### 2.2 División del trabajo en pestañas de herdr

**Se deja a criterio del orquestador** dividir el trabajo en pestañas de herdr **cuando iniciar una tarea en un contexto limpio sea una prioridad clara y necesaria**. Ejemplos de cuándo está justificado:

- Unidades de trabajo independientes y con superficies de edición disjuntas que pueden avanzar en paralelo (p. ej., dos adaptadores distintos).
- Una tarea cuyo contexto acumulado en la sesión actual ya perjudica la calidad y conviene arrancarla de cero.
- Trabajo de larga duración (ingesta de fixtures grandes, refactors amplios) que no debe bloquear la sesión principal.

Cuando no haya una razón clara, el orquestador trabaja en su sesión actual o usa los subagentes de gentle-shell según sus reglas habituales. Reglas al usar pestañas:

- Cada pestaña recibe una tarea acotada que apunte a la sección concreta de esta spec o al documento de feature, nunca un resumen parafraseado.
- Cada pestaña nombra claramente su tarea para que su estado sea reconocible en la barra lateral de herdr.
- El orquestador sigue siendo responsable del alcance, de integrar los resultados y de verificar con `pnpm check` antes de dar algo por cerrado.
- Las tareas paralelas trabajan en worktrees o ramas separadas para no pisarse.

### 2.3 Convenciones

- Conventional commits.
- Código, identificadores, claves, nombres de tablas, comentarios, mensajes de commit, PRs y documentación técnica en **inglés**.
- `README.md` y `AGENTS.md` en **inglés**; esta spec en **español**.
- Interfaz **multidioma español/inglés**, con español por defecto (ver §8.5). Las claves de traducción van en inglés.

---

## 3. Fuentes de datos (adaptadores)

Cada agente tiene un adaptador independiente que lee su almacenamiento local y emite datos en el esquema normalizado (§4). Los formatos **no son contratos públicos** y cambian entre versiones; cada adaptador debe validar su salida con Zod y tener fixtures reales anonimizadas.

| Agente | Ubicación conocida | Formato | Prioridad |
|---|---|---|---|
| Claude Code | `~/.claude/projects/` | JSONL por sesión | Fase 1 |
| gentle-shell | `~/.gentle-shell/agent` (home propia) o `~/.pi/agent` (modo `--link`) | **Verificar** | Fase 1 |
| Pi | `~/.pi/agent` | **Verificar** | Fase 1 |
| OpenCode (actual) | `${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db` | SQLite | Fase 2 |
| OpenCode (legacy) | `~/.local/share/opencode/storage/` (`session/`, `message/`, `part/`, `session_diff/`) | JSON sueltos | Fase 2 |
| Codex CLI | `~/.codex/sessions/` | JSONL (**verificar**) | Fase 3 |

### Requisitos comunes

- **Solo lectura.** Nunca escribir ni bloquear ficheros de los agentes. Para SQLite, abrir en modo solo lectura.
- **Ingesta incremental.** Recordar qué se ha ingerido (por fichero + offset/hash, o por id de sesión) para no reprocesar.
- **Idempotencia.** Ingerir dos veces lo mismo no duplica filas.
- **Tolerancia a errores.** Una línea o sesión corrupta se registra como incidencia y no detiene la ingesta.
- **Versión del formato.** Cada sesión guarda qué versión de adaptador/formato la interpretó.

### Avisos

- Claude Code borra por defecto los transcripts antiguos (`cleanupPeriodDays`, 30 días por defecto). El README debe recomendar ampliarlo.
- En gentle-shell la captura del historial de prompts está desactivada por defecto. Documentar cómo activarla si se quiere analizar prompts.

---

## 4. Modelo de datos normalizado

Almacenado en DuckDB. Nombres orientativos; el esquema exacto se define en `packages/core` con Zod y migraciones SQL numeradas.

| Tabla | Contenido principal |
|---|---|
| `sources` | Agente, ruta de origen, versión de adaptador, última ingesta |
| `sessions` | id, agente, cwd/repo, rama, inicio, fin, título |
| `turns` | sesión, índice, rol, timestamp, modelo, proveedor, esfuerzo/razonamiento |
| `usage` | turno, tokens input / output / cache read / cache write, coste reportado (si existe), coste calculado |
| `tool_calls` | turno, herramienta, duración, resultado (ok/error) |
| `subagent_runs` | sesión padre, rol (explorer, writer, verifier, reviewer…), modelo, tokens, coste, duración |
| `profiles` | Instantáneas versionadas (hash) de las definiciones de perfiles de gentle-shell |
| `turn_profile` | Perfil activo en cada turno + si la atribución es **exacta** o **estimada** |
| `pricing` | Precio por millón de tokens por modelo, proveedor y rango de fechas |
| `subscriptions` | Cuenta/plan del usuario (p. ej. Claude Max, OpenCode Go) y sus límites |
| `quota_windows` | Ventanas calculadas (5 h, semanal, mensual) con consumo estimado |
| `calibrations` | Lecturas manuales del % real mostrado en la consola del proveedor |
| `commits` | Commits de los repos detectados, enlazables a sesiones por repo + rango temporal |
| `ingest_issues` | Errores de parseo y avisos |

### Reglas

- **Coste:** si el agente reporta coste, se guarda tal cual; además siempre se calcula con `pricing` para poder comparar. Se muestran ambos cuando difieren.
- **Precios y límites son datos**, no código: ficheros JSON versionados con fechas de vigencia.
- **Atribución de cuota por suscripción, no por agente.** Varios agentes pueden consumir la misma cuota (p. ej., OpenCode y gentle-shell usando OpenCode Go).

---

## 5. Cuotas y ventanas

### 5.1 Suscripciones soportadas

| Suscripción | Ventanas | Unidad del límite |
|---|---|---|
| Claude (Pro/Max) | 5 horas y semanal | No pública en tokens: estimación + calibración |
| OpenCode Go | 5 h: 12 $ · semanal: 30 $ · mensual: 60 $ | Dólares de uso |

Los valores de límites viven en `data/subscriptions.json` y deben revisarse periódicamente.

### 5.2 Requisitos

- Línea de tiempo de ventanas de 5 h, cada una coloreada por % de consumo estimado.
- Medidores semanal y mensual con fecha de reinicio.
- **Proyección de ritmo:** hora estimada a la que se alcanzará el límite al ritmo actual.
- **Valor extraído:** equivalente en precio API frente a lo pagado por la suscripción.
- Registro de uso por encima del límite (p. ej., fallback de OpenCode Go a saldo de pago).

### 5.3 Exactitud y calibración

Las ventanas reconstruidas en local son **estimaciones**: los proveedores calculan sus ventanas en servidor y no siempre exponen una API de uso. Por eso:

- Toda cifra de ventana se marca visualmente como estimada.
- El usuario puede introducir a mano el % que ve en la consola del proveedor; One More Token usa esas lecturas para ajustar su estimación y muestra la desviación histórica.

---

## 6. Perfiles de gentle-shell

Un perfil define el enrutado completo: modelo, proveedor y esfuerzo del orquestador y de cada rol de agente. Comparar perfiles es comparar configuraciones.

### 6.1 Métricas

- Coste y tokens por perfil: total, por sesión, por commit y por feature cerrada.
- Desglose por rol dentro del perfil (orquestador, explorer, writers, verifier, reviewers).
- Calidad: rondas de corrección y aceptación a la primera en revisión.
- Esfuerzo como dimensión independiente (mismo modelo, distinto esfuerzo).
- Qué cuotas de suscripción drena cada perfil.

### 6.2 Reglas de atribución

- **Por turno, no por sesión:** aplicar un perfil cambia el modelo de la sesión en vivo.
- **Definiciones versionadas:** un perfil puede editarse; cada turno referencia la instantánea vigente.
- **Atribución exacta vs estimada:** desde la v4.1 el perfil se vincula a la sesión. Para sesiones anteriores, inferir el perfil cruzando modelos por rol con las instantáneas, y marcarlo como estimado.
- **Primera tarea de la fase:** inspeccionar el almacenamiento de gentle-shell para confirmar dónde se persiste el perfil activo antes de diseñar el adaptador.

### 6.3 Sesgo de selección

- Las comparativas por defecto agrupan por clase de tarea (inline frente a feature con documento ODD).
- **Modo experimento:** registrar la misma tarea ejecutada con dos perfiles (en worktrees separados) y compararlas lado a lado.

---

## 7. Dashboard

### 7.1 Vistas

1. **Resumen:** tokens (M), coste y sesiones del periodo; estado de cuotas; tendencias.
2. **Burn rate:** ventanas 5 h / semanal / mensual por suscripción, proyección de ritmo y calibraciones.
3. **Explorador:** pivot libre (§7.2).
4. **Sesión:** detalle turno a turno, curva de contexto con compactaciones, herramientas, subagentes y diff de commits asociados.
5. **Perfiles:** comparativas de §6.
6. **Agentes:** misma clase de tarea en Claude Code, OpenCode y gentle-shell.
7. **Git:** tokens por commit, por línea neta y por PR; sesiones sin commit («tokens huérfanos»).
8. **Herramientas:** por herramienta, llamadas, errores, tiempo, tokens, coste y ritmo de consumo, para distinguir las herramientas eficientes de las que consumen en exceso.
9. **SQL:** consola sobre DuckDB con vistas guardadas.

### 7.2 Explorador (pivot)

- **Métricas:** input, output, cache read, cache write, total, coste calculado, coste reportado, ratio de acierto de caché, nº de turnos, nº de sesiones.
- **Dimensiones:** agente, modelo, proveedor, suscripción, perfil, rol, esfuerzo, repo, rama, herramienta, día, hora del día, día de la semana.
- **Gráficos:** barras (apiladas o agrupadas), líneas, área, heatmap, treemap, sankey, dispersión.
- **Filtros** combinables y rango temporal libre.
- Toda vista configurada se puede **guardar** como especificación Vega-Lite + consulta, en un fichero JSON.
- Unidades por defecto en millones de tokens (M) con un decimal.

---

## 8. Diseño y experiencia (UX/UI)

### 8.1 Intención

Quien usa One More Token es un **director de agentes que no para de crear**: entra entre tarea y tarea para ver cómo va, decidir qué perfil o modelo usar y perderse un rato explorando datos. La interfaz debe ser **ágil, cool y funcional**, y dar ganas de volver porque se está a gusto y se encuentra lo que se busca. Eso se concreta en:

- **Inmediatez.** Las interacciones se sienten instantáneas; objetivo: consultas del explorador por debajo de 500 ms con un año de datos.
- **Encontrar sin pensar.** Paleta de comandos (`Ctrl/⌘+K`) que busca vistas, sesiones, repos, perfiles y vistas guardadas. La URL refleja siempre el estado (vista, filtros, rango), así que todo es enlazable y recuperable.
- **Teclado primero, ratón también.** Atajos con espíritu de terminal y Vim: `j`/`k` para moverse, `/` para buscar, `g` + letra para saltar de vista, `?` para ver todos los atajos.
- **Continuidad.** Recuerda la última vista, los filtros y el rango temporal entre visitas.
- **Inicio que responde «¿cómo voy?»** en un vistazo: estado de las cuotas activas y lo último que hiciste.
- **Un elemento firma.** La línea de tiempo de ventanas de 5 h es el elemento memorable del producto; el resto de la interfaz se mantiene sobrio y disciplinado para que destaque.

### 8.2 Sistema de diseño

- **Fuente única de tokens** (color, tipografía, espaciado, radios, bordes, movimiento) en `data/theme/`, convertidos a CSS custom properties. Ningún componente usa valores escritos a mano.
- **Componentes base reutilizables** con todos sus estados definidos: reposo, hover, foco, activo, deshabilitado, cargando, vacío y error.
- **Vocabulario coherente.** Una acción se llama igual en el botón, el atajo, la paleta de comandos y el aviso que confirma («Guardar vista» → «Vista guardada»).
- **Densidad seleccionable** (cómoda / compacta), al estilo de gentle-shell.
- **Gráficos integrados en el sistema.** El tema de Vega-Lite se genera desde los mismos tokens. Cada entidad tiene un color estable en todos los gráficos (un modelo, agente o perfil siempre se pinta igual).
- **Jerarquía de TUI bien hecho, no de plantilla SaaS.** Nada de rejillas de tarjetas idénticas con la misma sombra; la estructura se expresa con tipografía, espaciado, paneles y bordes finos, como en Zellij.

### 8.3 Tema: Kanagawa de terminal, en web

- **Inspiración:** la estética Kanagawa de terminal, similar a la configuración de gentle-shell y Zellij del usuario, trasladada a la web.
- **Primera tarea de diseño:** extraer la paleta exacta de los temas activos del usuario en gentle-shell y Zellij y mapearla a tokens semánticos. Si no es posible, usar la paleta de referencia de abajo.
- **Claro y oscuro elegibles:** selector Sistema / Claro / Oscuro, persistido y sin parpadeo al cargar.
- **Variantes:** oscuro basado en Kanagawa **Wave** (con **Dragon** como alternativa más profunda) y claro basado en Kanagawa **Lotus**.
- **Tokens semánticos:** `bg`, `surface`, `surface-raised`, `border`, `fg`, `fg-muted`, `accent`, `success`, `warning`, `danger`, `info` y una serie ordenada de colores para gráficos.

Paleta de referencia (verificar contra el repositorio oficial de kanagawa.nvim antes de fijarla):

| Rol | Wave (oscuro) | Lotus (claro) |
|---|---|---|
| Fondo | `#1F1F28` | `#F2ECBC` |
| Superficie | `#2A2A37` | `#E5DDB0` |
| Borde | `#54546D` | `#DCD5AC` |
| Texto | `#DCD7BA` | `#545464` |
| Texto atenuado | `#727169` | `#8A8980` |
| Acento (azul) | `#7E9CD8` | `#4D699B` |
| Éxito (verde) | `#98BB6C` | `#6F894E` |
| Aviso (amarillo) | `#E6C384` | `#77713F` |
| Naranja | `#FFA066` | `#CC6D2E` |
| Peligro (rojo) | `#E46876` | `#C84053` |
| Violeta | `#957FB8` | `#624C83` |
| Rosa | `#D27E99` | `#B35B79` |
| Aguamarina | `#7AA89F` | `#597B75` |

- **Tipografía:** una monoespaciada con cifras tabulares para datos, números y código (idealmente la misma familia que use el usuario en la terminal), y como mucho una sans legible para textos largos.
- **Guiños de terminal con mesura:** barra de estado inferior al estilo Zellij (rango temporal, filtros activos, estado de la ingesta y modo de tema) y una paleta de comandos con aspecto de prompt. La referencia es el ambiente de la terminal, no imitarla de forma literal.

### 8.4 Calidad mínima

- Contraste WCAG AA en ambos temas. Algunos tonos atenuados de Kanagawa pueden no llegar: se ajustan los tokens, no se ignora la regla.
- Foco siempre visible y navegación completa por teclado.
- Se respeta `prefers-reduced-motion`. El movimiento solo acompaña a acciones del usuario (abrir, expandir, confirmar).
- Responsive: cómodo en portátil y monitor ancho; lectura básica en móvil.
- Los estados vacíos invitan a actuar, con el comando o paso concreto (p. ej., cómo ingerir la primera fuente).
- Los errores dicen qué ha pasado y cómo arreglarlo, sin disculpas ni vaguedades.
- Textos en minúscula de frase, verbos claros y sin relleno, en ambos idiomas.

### 8.5 Idiomas (español / inglés)

- **Selector de idioma** Español / English, accesible desde ajustes y desde la paleta de comandos. Por defecto se toma el idioma del navegador (español si no es ninguno de los dos) y la elección se persiste.
- **Ningún texto visible escrito en el código.** Todo pasa por claves de traducción en inglés (`quota.window.fiveHours`) con catálogos `es` y `en` que deben tener exactamente las mismas claves.
- **Formatos según idioma:** números, fechas, horas y separadores con `Intl` (p. ej., `1,5 M` frente a `1.5 M`). Los importes se muestran en dólares, que es la unidad de los límites, formateados según el idioma.
- **Plurales correctos** con reglas de pluralización, no con concatenaciones.
- **Gráficos traducidos:** títulos, ejes, leyendas y tooltips de Vega-Lite usan el catálogo activo y el formato numérico del idioma.
- **Cambio en caliente**, sin recargar la página y conservando la vista y los filtros.
- **Alcance:** dashboard, informes en markdown y alertas salen en el idioma elegido. La CLI y los logs técnicos quedan en inglés.
- **Vocabulario coherente en los dos idiomas:** un glosario mínimo (sesión/session, ventana/window, perfil/profile, cuota/quota…) en `apps/web/src/i18n/glossary.md`. «One More Token» y «Burn rate» son nombres propios y no se traducen.

---

## 9. Informes y alertas

- Informe semanal y «wrapped» mensual generados en markdown, en el idioma elegido.
- Exportación de cualquier gráfico a PNG/SVG y de cualquier tabla a CSV.
- Alertas configurables por umbral de ventana (p. ej., 80 %) con canal enchufable; primer canal: Telegram.

---

## 10. Privacidad

- Todo se ejecuta y almacena en local. Sin telemetría.
- Redacción de secretos al ingerir (claves API, tokens, variables de entorno sensibles) antes de guardar texto.
- Opción para ingerir solo métricas, sin contenido de mensajes.

---

## 11. Stack y estructura

### 11.1 Stack

| Capa | Elección |
|---|---|
| Lenguaje | TypeScript estricto en todo el proyecto |
| Runtime | Node 22+ con pnpm (monorepo) |
| Base de datos | DuckDB (`@duckdb/node-api`), un único proceso escritor |
| Contratos | Zod |
| Backend | Hono, API que devuelve datos ya agregados |
| Frontend | React + Vite |
| Gráficos | Vega-Lite |
| Estilos | CSS con custom properties generadas desde los tokens de `data/theme/` |
| Idiomas | i18next + react-i18next, formatos con `Intl` |
| Calidad | Vitest, Biome, `tsc --noEmit` |

La ingesta (incluido el modo `watch`) corre dentro del mismo proceso que el servidor para respetar el único escritor de DuckDB.

### 11.2 Estructura del repositorio

```
one-more-token/
├── AGENTS.md              # Instrucciones para agentes (fuente única)
├── CLAUDE.md              # Importa @AGENTS.md
├── docs/
│   └── spec.md            # Este documento
├── data/
│   ├── pricing.json       # Precios por modelo con fechas de vigencia
│   ├── subscriptions.json # Planes y límites
│   └── theme/             # Tokens de diseño (Kanagawa claro/oscuro)
├── packages/
│   ├── core/              # Esquema, migraciones, precios, ventanas, atribución
│   └── adapters/
│       ├── claude-code/
│       ├── gentle-shell/
│       ├── pi/
│       └── opencode/
│           └── fixtures/  # Sesiones reales anonimizadas
└── apps/
    ├── cli/               # omt ingest | watch | serve
    └── web/               # Dashboard
        └── src/i18n/      # Catálogos es.json, en.json y glosario
```

### 11.3 Reglas para agentes

Las reglas completas viven en `AGENTS.md` (en inglés), que es la fuente única de instrucciones para agentes; `CLAUDE.md` solo contiene `@AGENTS.md`. Resumen:

- La verificación única es `pnpm check` (tipos, lint y tests). Nada se da por terminado si falla.
- Cambios de comportamiento: test primero cuando exista un test ejecutable aplicable.
- Cada adaptador tiene tests de snapshot: fixture de entrada → salida normalizada esperada.
- Nunca modificar ficheros de los agentes fuente; los tests usan solo fixtures.
- Precios y límites se cambian en `data/`, no en el código.
- Cambios de esquema solo mediante nueva migración numerada.
- La UI usa solo tokens del sistema de diseño y componentes base; nada de colores ni medidas sueltas (§8.2).
- Todo texto visible usa una clave de traducción presente en `es` y `en`; `pnpm check` falla si a un catálogo le falta una clave (§8.5).

### 11.4 README y badge «Built with Gentle-AI»

El README termina con el badge oficial **«Built with Gentle-AI»**, que el propio README de Gentle-AI invita a usar a los proyectos hechos con Gentle-AI:

```html
<p align="center">
  <a href="https://github.com/Gentleman-Programming/gentle-ai">
    <img width="220" src="https://raw.githubusercontent.com/Gentleman-Programming/gentle-ai/main/docs/assets/brand/built-with-gentle-ai.png" alt="Built with Gentle-AI">
  </a>
</p>
```

- **La URL de la imagen se mantiene exactamente así.** El autor de Gentle-AI la usa para encontrar y destacar los proyectos que llevan el badge, así que no se copia la imagen al repo ni se cambia la ruta.
- Debajo del badge, la línea «Independent project, built with Gentle-AI and gentle-shell.», que deja claro en tono natural que es un proyecto independiente.
- El mismo badge, en pequeño, puede aparecer en la vista «Acerca de» del dashboard.

---

## 12. Fases

| Fase | Entregable | Criterio de cierre |
|---|---|---|
| 0 | Monorepo, `pnpm check`, AGENTS.md, README con créditos a Gentle-AI (§11.4), esquema y migraciones iniciales, tokens de tema, componentes base e i18n | `pnpm check` en verde; tema claro y oscuro con contraste AA; cambio de idioma ES/EN en caliente |
| 1 | Adaptadores Claude Code + gentle-shell/Pi, CLI `ingest`, vista Resumen | Ingesta real de una semana de sesiones sin incidencias críticas |
| 2 | Explorador pivot, vista Sesión, adaptador OpenCode (SQLite + legacy) | Al menos 5 vistas guardadas útiles |
| 3 | Cuotas y calibración, perfiles de gentle-shell | Desviación media frente a calibraciones documentada |
| 4 | Git, informes, alertas, consola SQL, Codex | Informe semanal generado automáticamente |

---

## 13. Preguntas abiertas

0. ¿Qué licencia open source? (MIT encaja con el ecosistema de Gentle-AI y gentle-shell; decidir antes del primer release.)

1. ¿Dónde persiste gentle-shell el perfil activo por sesión y el uso por subagente? (bloquea §6)
2. ¿Formato exacto de las sesiones de Pi y de la home propia de gentle-shell?
3. ¿Cómo distinguir de forma fiable qué suscripción usó cada turno cuando el proveedor es el mismo (API de pago frente a plan)?
4. ¿Merece la pena una versión de lectura en el móvil, o basta con el dashboard en escritorio?

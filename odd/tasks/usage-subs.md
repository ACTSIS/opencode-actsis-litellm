# usage-subs — usage-subs command (cloud subscription usage)

Show Ollama Cloud per-subscription usage (5h rolling + weekly windows, credits) by
querying the gateway's `/ollama-usage` pass-through. Contract lives in
`llm-server/odd/tasks/usage-subs.md` S6 (canonical); this doc mirrors the plugin side.

## Specs

- S1 (verbatim, user): "El comando sería usage-subs" — OpenCode command
  `actsis-litellm:usage-subs` + tool `actsis_litellm_usage_subs`, following the
  existing `actsis-litellm:usage` / `actsis_litellm_usage` registration pattern.
- S2: data from a single `GET {gateway}/ollama-usage` (no range param) using the
  same resolved credential tools use (v2 integration reader, v1 auth.json fallback);
  401/403/network errors reuse existing handling. 404 means the gateway does not
  expose this pass-through.
- S3: render per subscription: name, 5h-window and weekly usage as
  `usageGauge()` bars vs `limitUsd` when present, absolute spend/requests/tokens otherwise;
  credits line when present. Mirrors pi sibling rendering.
- S4: mirrors the pi sibling implementation (same shared mirror discipline).

## Tasks

- T1 → S2: `src/usage-subs.ts` client + parsing per S6 contract (null-tolerant).
- T2 → S1: command + tool wiring in `plugin.ts`/`tools.ts`.
- T3 → S2-S4: tests (`test/usage-subs.test.ts`): fetch shape, 401/403/404 handling,
  rendering, command/tool wiring.
- T4 → S3: widget color via OpenTUI span `style={{fg}}` segments
  (`src/tui.tsx`, `src/budget-widget.ts`), threshold hex in `src/gauge-color.ts`.
- T5 → S3: chat color via `ansi` code-block renderer (`src/ansi.ts` parser +
  registration in `src/tui.tsx`); tool descriptions and command templates demand
  the `ansi` fence (`src/tools.ts`, `src/plugin.ts`).

## Log

- L1 (verbatim, user): "Me encanta la solución propuesta. El comando sería usage-subs"
- L2: repo pair discipline: mirrors pi-actsis-litellm `usage-subs` implementation.
- L3: contract simplified to ONE GET returning both windows and credits
  (`/ollama-usage` without range param): fewer upstream calls and no path
  interpolation on the LiteLLM pass-through. S2/S3 updated accordingly.- L4: implemented on feat/usage-subs, work units verified 431/431 tests + typecheck:
  070d9c4 (feature), afc2412 (lockfile sync chore), 1d4ea2c (docs). Mirrors pi
  sibling commit 72eb208.
- L5: legacy-plan window quotas rendered: credits.session/credits.weekly carry
  remaining_percent + resets_at surfaced by the collector (llm-server L8); plugin
  renders used% gauge + resets per window (mirrors pi 7079ce1).
- L6 (verbatim, user): "Momento, visualmente no me gusta, tratemos de tabular, como lo hacemos con el comando "usage", para que visualmente sea más ordenado". Render rewritten as the /usage-style table (mirrors pi 1afdcf1); verified typecheck OK + 432/432 tests.
- L7: gauge color code mirrored (GAUGE_COLORS truecolor thresholds, visible-length
  padding, {color} option) but NOT wired: opencode tool surfaces lack an ANSI
  guarantee; wire after visual confirmation (pi sibling f7d37be wires it).
- L8: delivered via PR https://github.com/ACTSIS/opencode-actsis-litellm/pull/8, merge
  fac6d0b to main (feat/usage-subs 070d9c4→d81ca3f→539741d→471fa02).
- L9 (verbatim, user): "Pero necesito el color activo, por ahora en Opencode muestra
  bien la estructura de la tabla, pero todo en colo blanco". Wired: tool emits
  {color: true}; ANSI-aware evidence: structure rendered fine + Bun.stripANSI/
  countAnsiEscapeCodes present in the binary.
- L10 (verbatim, user): "Amiguis, los ajustes que hicimos no funcionaron, todo
  sigue sin colr, ni en el chat ni el el widget: [Image 1]". Root causes con
  evidencia (2026-10-16): (a) el reconciler de @opentui/solid IGNORA props
  sueltas en nodos de texto — setProperty solo maneja `style` y `href`, así que
  `<span fg="...">` (fix anterior) renderizaba blanco (node_modules/@opentui/solid/index.js:634, setProperty de text-node); OpenCode mismo
  compila spans como `style={{fg}}`;
  (b) el chat nunca interpreta SGR en fences normales — el mecanismo soportado
  es `context.markdown.registerCodeBlockRenderer(language, render)` (
  node_modules/@opencode/plugin/dist/tui/context.d.ts:469; host: plugins builtin
  `opencode.latex` y `opencode.merman` lo usan para pintar chat). Fix inline:
  `src/ansi.ts` (parser SGR truecolor→runs, 14 tests) + renderer ```ansi
  registrado en `src/tui.tsx` + spans con `style={{fg}}` + templates y
  descripciones de tools exigen fence `ansi` (`src/tools.ts` RELAY_VERBATIM,
  `src/plugin.ts`). Typecheck OK, 474/474 tests, dist regenerado. Verificado
  visualmente por el usuario: widget OK, chat aún sin color.
- L11 (2026-10-16): root cause del chat con evidencia de datos: la fila del
  assistant en opencode.db (`session_message msg_14681df250018W6tlAKul6qqYt`)
  guarda 0 bytes ESC — el runtime elimina el byte de escape al persistir el
  texto del modelo, así que el renderer recibía fragmentos literales y no había
  nada que parsear. Fix: `src/ansi.ts` reconoce también fragmentos ESC-less
  (`\[[0-9;:]*[A-Za-z]`, params ≥1 y final letra), sin falsos positivos en
  corchetes normales, con test de reproducción del texto exacto almacenado.
  Typecheck OK, 479/479 tests, dist regenerado. Pendiente: verificación visual
  del usuario tras reiniciar la TUI.
- L12 (2026-10-16): entregado issue#24 → rama bugfix/widget-chat-color
  (5e010d1 widget segments; d01d088 ansi renderer + fragment parsing + templates
  + docs) → PR #25 → merge be9f323 a main. Verificación en vivo del usuario:
  widget OK; fence ansi del chat pendiente de reconfirmar. Release v0.6.3
  preparada en main (sin tag); corte/etiquetado espejado con pi pendiente de
  decisión.
- L13 (2026-10-16, verificación visual del usuario con captura): "Todo quedó
  maravillosamente bien" — widget Budget coloreado por banda, fences `ansi` del
  chat pintando truecolor (uso-subs verde/amarillo/naranja/rojo y budget),
  templates exigiendo el ansi info string funcionando en vivo. Feature color
  cerrada; release v0.6.3 queda etiquetada en el corte de par pendiente.
- L14 (2026-10-16, corte de par): v0.6.3 etiquetada y publicada en ambos
  repos. opencode: tag `v0.6.3` + release con notes (head `70811dd`). pi:
  una sesión del par ya había mergeado su prep (PR #41, changelog completo
  #37/#38/#39, versiones a 0.6.3); mi prep duplicado (PR #42) se cerró con
  comentario y su rama eliminada; tag `v0.6.3` (f5fc081) + release publicada.
  Sin publicación en npm. Par v0.6.3 completo (Latest en ambas).

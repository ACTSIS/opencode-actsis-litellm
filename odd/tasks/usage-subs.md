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

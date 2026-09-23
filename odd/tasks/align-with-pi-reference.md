# Feature: align opencode plugin with pi reference (052c9ca..0165eae)

Align the OpenCode plugin (`~/Workspace/opencode-provider-litellm`, branch
`main`) with the feature set and fixes already shipped in the sibling pi
plugin (`~/Workspace/pi-provider-litellm`, commits 052c9ca..0165eae). The pi
plugin is the reference implementation; read its files when behavior is
ambiguous.

## Allowed edit surfaces
- src/**
- test/**
- README.md
- CHANGELOG.md

Reference (read-only): `~/Workspace/pi-provider-litellm/extensions/index.ts`,
`extensions/lib/catalog.ts`, `extensions/lib/budget.ts`.

Constraints: OpenCode idioms (tools return strings, no pi-specific APIs); no
dependency on gentle-pi/pi packages; artifacts in English; Conventional
Commits, one work-unit commit per work item (7 commits max); do NOT push.

## Tasks

### A1. Rename tools to the actsis-litellm namespace (pi 052c9ca)
- src/tools.ts: litellm_status -> actsis_litellm_status,
  litellm_models -> actsis_litellm_models, litellm_logout ->
  actsis_litellm_logout. Update src/plugin.ts, test/tools.test.ts, README.
- Display name "ACTSIS LiteLLM" -> "Actsis LiteLLM" in src/plugin.ts
  (buildProviderInjection `name:` field); update README/CHANGELOG mentions.
- Acceptance: typecheck + tests green; commit.

### A2. Catalog parity (pi 1154f0b): cost tiers + v2 pagination + cache v2
- a) Cost tiers: input/output_cost_per_token_above_{128k,200k,272k,512k}_tokens
  -> tiered pricing metadata on model config (OpenCode-native shape if
  supported; otherwise `costTiers` informational extension field, documented).
  cache_read/cache_creation rates shared across tiers.
- b) Paginated fallback: when GET /v1/model/info fails or returns empty map,
  GET /v2/model/info?page=1&page_size=100 (Bearer), read total_pages, fetch
  up to 5 pages, merge by model_name (existing infoMapKey). Mirror
  pi client.fetchModelInfoV2.
- c) /v1/model/info enrichment keyed by model_name with nested model_info
  fields winning; add tests for nested merge if missing.
- Bump CACHE_SCHEMA_VERSION to 2 (invalidate stale caches without tiers).
- Acceptance: tests incl. suffix parsing and pagination mock; commit.

### A3. Budget gauge formatting (pi 6503017)
- src/budget.ts: public `budgetGauge(percent)`: 8 cells, "▰" filled, "▱"
  empty (GAUGE_CELLS = 8), clamped. `formatBudgetStatus(info)`:
  undefined when spend null; `Budget ${gauge} ${Math.round(percent)}% ·
  $X.XX/$Y.YY` when maxBudget > 0; `Budget $X.XX used (no cap)` otherwise.
  Glyphs local, no gentle-pi imports.
- Acceptance: boundary tests (0/50/100, clamping), capped/uncapped/null; commit.

### A4. Budget diagnostic tool (pi 0165eae)
- New tool actsis_litellm_budget in src/tools.ts, description "Force a budget
  refresh and report the exact outcome." Runs fetchGatewayBudget; single-line
  report ALWAYS stating outcome: formatBudgetStatus text on success, else
  precise failure ("no credential stored — run /login", "gateway URL not
  configured", AuthError message, network/timeout error).
- Register in buildLitellmTools + plugin tool map.
- Acceptance: success + failure-path tests; commit.

### A5. Surface failures in status tool (pi 2296166 part 2)
- litellm_status (renamed actsis_litellm_status): on budget fetch throw output
  "Budget unavailable: <reason>" instead of bare "Budget: unavailable". Keep
  AuthError wording ("Credential rejected by gateway. Run /login again.").
- Acceptance: wording tests; commit.

### A6. Event-driven budget refresh (pi agent_end)
- src/plugin.ts: event hook refreshes plugin-state budget snapshot on an
  end-of-agent-turn-equivalent event (session.idle / session events), storing
  last snapshot + timestamp in plugin state (src/state.ts) so
  actsis_litellm_status / actsis_litellm_budget can report a cached line
  between turns. If OpenCode Event type exposes nothing suitable, SKIP and
  document why in CHANGELOG instead of hacking around it.
- Acceptance: refresh-on-event test or documented skip; commit.

### A7. Final verification and report
- npm run typecheck clean; npm test green (all suites).
- Report: commit list, test totals, deviations with reasons.

## Evidence log

- 2026-09-23: Task received from user; explorer subagent mapped pi reference
  (budget gauge, cost tiers, v2 pagination, diagnostic command, agent_end
  refresh) against target state. Key finding: OpenCode supports native
  cost.tiers ({input, output, cache, tier:{type:"context",size}}) so no
  informational extension field needed; session.idle exists → item 6 viable.
- 2026-09-23 A1 (commit 2f82b3a): tools/commands renamed to actsis_litellm_*/
  /actsis-litellm-*; display name "Actsis LiteLLM". 171 tests.
- 2026-09-23 A2 (commit 002a319): cost.tiers native shape (128k/200k/272k/
  512k suffixes, shared cache rates, sorted, attached only when non-empty);
  fetchModelInfoV2 + paginated fallback (size=100&page=N, total_pages, max 5
  pages, merged by model_name); CACHE_SCHEMA_VERSION 1→2. One deviation
  handled: test/tools.test.ts cache fixtures bumped to version 2 (writer
  surfaces excluded that file; parent authorized the edit). 185 tests.
- 2026-09-23 A3 (commit 6c3915a): budgetGauge + formatBudgetStatus (8 cells,
  ▰/▱, clamped; capped/uncapped/null forms) mirroring pi 6503017. 196 tests.
- 2026-09-23 A4 (commit 2dcd7b1): actsis_litellm_budget tool, always reports
  exact outcome (gauge line / no spend data / no credential / gateway URL /
  AuthError / error: <reason>) mirroring pi 0165eae. 202 tests.
- 2026-09-23 A5 (commit 236eb08): status surfaces "Budget unavailable:
  <reason>" + AuthError special case, mirroring pi 2296166. 204 tests.
- 2026-09-23 A6 (commit 8bec8df): event hook on session.idle persists
  lastBudgetSnapshot/budgetRefreshedAt (additive optional PluginState fields,
  schema v1 kept); budget/status tools report cached last-known lines on
  failure. 210 tests.
- 2026-09-23 Final: npm run typecheck clean; npm test 13 files, 210/210
  green. 6 work-unit commits on main (A1–A6), nothing pushed (user pushes).
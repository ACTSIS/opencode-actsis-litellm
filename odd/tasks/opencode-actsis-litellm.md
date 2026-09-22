# Feature: opencode-actsis-litellm

OpenCode plugin that adds ACTSIS LiteLLM gateway as a dynamic provider with
`/login`-style OAuth2 PKCE (native CLI contract), dynamic model catalog sync,
and request hardening — port of the pi-provider-litellm extension.

## Approved decisions (user, 2026-09-22)
- Name: `opencode-actsis-litellm` (avoids npm collision with community
  `opencode-provider-litellm`).
- Scope: full parity with pi version — OAuth PKCE + dynamic catalog +
  status/models/logout tools + 429/overflow normalization + budget info.
- Distribution: public repo github.com/ACTSIS/opencode-actsis-litellm —
  no internal hosts/data in committed code or docs.
- At the end: replace `opencode-provider-litellm@0.10.0` and the manual
  `actsis` provider block in the user's `~/.config/opencode/opencode.json`
  with this plugin.

## Research summary (verified against installed opencode 1.18.31 / plugin 1.18.25)

- OpenCode plugin = module exporting a `Plugin` fn returning `Hooks`.
- `auth` hook: `methods[]` with `prompts` (text/select + validate + when)
  run BEFORE `authorize(inputs)` — used for gateway URL + auth-mode picker
  (zero-config parity). OAuth method returns
  `{url, instructions, method: "auto", callback(): Promise<result>}`;
  result `{type:"success", refresh, access, expires, ...extras}` is persisted
  by OpenCode to `~/.local/share/opencode/auth.json` (extras preserved in
  practice by auth.set body spread; typed as OAuth with extras stripped —
  do NOT rely on extras; keep gateway state in plugin-owned state file).
- `auth.loader(getAuth, provider)` → `{apiKey, baseURL, fetch}`: per-request
  Authorization injection + proactive refresh persisted via
  `client.auth.set({path:{id}, body:{type:"oauth",...}})` (Copilot/Codex
  pattern). Refresh state (tokenEndpoint/resource/clientId) from state file.
- `config` hook mutates Config: register provider
  `{npm:"@ai-sdk/openai-compatible", name, options:{baseURL, apiKey:""},
  models}` + inject `command` markdown commands for status/models/logout
  parity (commands execute a template prompt; plugin tool answers it).
- `provider.models` hook (Copilot uses it) resolves catalog per startup with
  `ctx.auth`; NOT required if config hook injects models — choose config-hook
  injection (matches community plugin, proven on 1.18.25).
- Events: `event` hook subscribes `{event:{type,properties}}`; only
  `session.error`/`message.part.updated` surface model errors. 429/overflow
  normalization implemented as `chat.headers` cannot; implemented via custom
  fetch in `auth.loader` (catch gateway error bodies, classify, rethrow
  enriched Error message; OpenCode retries 429 with backoff natively).
- Tools: `tool` hook with zod-ish `tool.schema`; `client.tui.showToast` for
  feedback. TUI toasts are TUI-only; server-side use `client.app.log`.
- Catalog: `/v1/models?include_metadata=true` + `/model/info` enrichment,
  chat-mode filter (mode metadata + conservative name regex), cache at
  `~/.local/share/opencode/actsis-litellm/models-cache.json` (schema version,
  atomic tmp+rename write), TTL 15 min (configurable via plugin options).
- State file: `~/.local/share/opencode/actsis-litellm/state.json` holds
  gatewayUrl, discovery snapshot, clientId, authMode (api_key|oauth),
  schemeUpgrade flag — written on login; read by loader/refresh.
- Config precedence for gateway URL: env `ACTSIS_LITELLM_URL` > plugin
  options (`opencode.json` `[pkg, {url}]` tuple) > stored state > login
  prompts (text prompt with validate).
- Model config mapping (OpenCode ModelV2 shape): `{name, tool_call,
  reasoning, limit:{context,output}, modalities, cost{input,output,
  cache_read,cache_write}}`; costs per-token ×1e6.
- Plugin package shape: `package.json` `exports: {".": "./src/index.ts",
  "./server": "./src/index.ts"}` with `files:["src"]` (community plugin
  ships TS source; OpenCode runs Bun). Install via `plugin: ["git:..."]` or
  local path; `@opencode-ai/plugin` as dependency.
- Tests: vitest run (Bun/node compatible); mock `fetch` via globalThis
  injection; no network in tests.

## Tasks

### T1. Scaffold package + repo hygiene
- package.json (name opencode-actsis-litellm, exports ./src/index.ts and
  ./server, deps @opencode-ai/plugin, engines opencode >=1.14.0, scripts
  test/typecheck), tsconfig, vitest config, LICENSE (MIT), README placeholder
  (public-safe), docs/login-flow.md, .gitignore, CHANGELOG.
- Acceptance: npx tsc --noEmit green; npm test green (no tests yet OK);
  no internal hosts in tracked files.

### T2. Config module (port config.ts + gateway-url.ts)
- resolveConfig with env/options/stored/prompt precedence, normalizeBaseUrl
  (strip trailing /v1), gateway-url.ts helpers (stored-credential origin,
  scheme upgrade).
- Acceptance: unit tests green, pure functions, no host literals.

### T3. LiteLLM client module (port client.ts)
- Discovery fetch + validation (contract_version=1, S256, same-origin,
  scheme-upgrade adaptation), registerClient, exchangeAuthorizationCode,
  refreshGrant (rotation), revokeToken, fetchModels, fetchModelInfo,
  fetchBudgetInfo; redirect: "manual" guard; timeout via AbortSignal.
- Acceptance: unit tests with mocked fetch; contract validation covered.

### T4. OAuth PKCE login flow (port pkce.ts + oauth.ts)
- generatePkce/randomState, LoopbackCallbackServer (127.0.0.1, ephemeral,
  /callback, pending buffer, 5-min timeout), runLoginFlow adapted to return
  AuthOAuthResult-compatible credentials: OpenCode calls authorize() once →
  we start loopback server, return {url, instructions, method:"auto",
  callback}; callback awaits loopback code, validates state, exchanges,
  persists state file, returns {type:"success", refresh, access, expires}.
- Prompts (before authorize): gateway URL (when not configured, with
  validate), method select (SSO vs API key).
- API key path: validate key against /v1/models, synthesize credentials,
  persist authMode=api_key in state file.
- Acceptance: unit tests PKCE/state/parse; loopback server test.

### T5. State file + catalog cache modules
- state.ts: read/write/update state.json (atomic), schema versioned.
- catalog-cache.ts: load/save/age with schema version + atomic rename
  (port catalog.ts cache functions, path under
  ~/.local/share/opencode/actsis-litellm/).
- Acceptance: unit tests green (tmp dirs, no network).

### T6. Catalog discovery + mapping (port catalog.ts)
- fetchCatalogModels: /v1/models (include_metadata) + /model/info
  enrichment, mode extraction (entry/litellm_params/metadata), chat filter
  (CHAT_MODES/NON_CHAT_MODES + NON_CHAT_ID_RE), map to OpenCode ModelV2
  config shape with per-million costs, defaults 128000/16384 → align to
  community plugin defaults (32768) decision: keep 128000/16384 (pi parity).
- Acceptance: unit tests mapping + filter + enrichment merge.

### T7. Plugin core: config hook + auth hook wiring (index.ts)
- Plugin factory: resolve non-interactive config; `config` hook injects
  provider (openai-compatible npm, baseURL, models from cache/discovery with
  TTL check) + registers markdown commands (litellm-status, litellm-models,
  litellm-logout templates instructing to call the custom tools).
- `auth` hook: loader (getAuth → {apiKey, baseURL, fetch}) with custom fetch
  doing: inject Bearer from oauth access or api key state; proactive refresh
  (expires margin 300s) persisted via client.auth.set + state update; 429
  budget/throttle classification → enriched Error message; overflow phrase
  detection → context_length_exceeded marker; keep X-Litellm-Session-ID
  header parity from community plugin.
- methods: prompts (url if needed, method select), SSO authorize
  (loopback PKCE auto), API key method (type api, prompt key, validate).
- Acceptance: unit tests for fetch wrapper classification + refresh
  persistence call; config injection merges without clobbering.

### T8. Tools + commands: status/models/logout
- tool definitions (litellm_status, litellm_models, litellm_logout) with
  tool.schema empty args; execute reads state + auth via client (auth.json
  via SDK? no — use getAuth closure from auth hook? tools run outside loader;
  read auth.json via SDK client.auth (none) — decide: plugin state file +
  client.auth via SDK `client.auth` endpoints unavailable; simplest: status
  reads state file + catalog cache + tries /key/info with token from
  auth.json file read (read-only, same location OpenCode uses).
- commands (config hook): markdown templates referencing the tools; toast/
  log output; force-sync models via direct fetchCatalogModels + cache update
  (config hook not re-runnable at runtime; document that new models appear
  after restart OR via provider.models hook — implement provider.models hook
  as the live path and config injection as bootstrap).
- Acceptance: unit tests for tool handlers; manual smoke in TUI.

### T9. Budget + limit/overflow normalization modules
- Port budget.ts (fetchBudgetInfo/formatBudgetLine/percent) — used by status
  tool and fetch wrapper budget warning; port limit-errors.ts classification
  and overflow.ts patterns; integrate into custom fetch (T7).
- Acceptance: unit tests green (pure functions).

### T10. Docs + packaging validation
- README public-safe (placeholders, install via git: / local path, config,
  commands table, troubleshooting, security notes), docs/login-flow.md
  sequence, CHANGELOG; leak-check no internal hosts; npm pack smoke; local
  install smoke in ~/.config/opencode (T11 covers global switch).
- Acceptance: docs reviewed; npm pack contains src only; smoke OK.

### T11. Global config switch (user machine)
- Replace `opencode-provider-litellm@0.10.0` entry with
  `opencode-actsis-litellm` (local path or git URL) in
  ~/.config/opencode/opencode.json; remove manual `actsis` provider block if
  covered; keep backup of previous config; verify opencode starts and lists
  gateway models after user login.
- Acceptance: opencode TUI shows actsis-litellm provider; login works;
  community plugin removed from config.

## Evidence log

- 2026-09-22: Research phase — verified plugin API against installed
  opencode 1.18.31 + @opencode-ai/plugin 1.18.25 types (local node_modules),
  official Copilot plugin source (provider.models + loader fetch pattern),
  Codex auth plugin (loopback + client.auth.set persistence), community
  opencode-provider-litellm 0.10.0 (config injection + model mapping
  defaults proven in this environment).
- 2026-09-22: Worktree infra fixed (same pattern as pi project): directory
  was standalone; recreated as orphan worktree of session clone on branch
  feature/opencode-actsis-litellm; registered for session.
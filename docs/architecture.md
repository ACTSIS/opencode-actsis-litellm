# Architecture

Technical overview of the `opencode-actsis-litellm` plugin: module map,
OpenCode integration points, provider/auth contracts, packaging and TUI
loader behavior, and the budget snapshot lifecycle.

For installation and login details see
[installation.md](installation.md) and [login-flow.md](login-flow.md).

## Module map (`src/`)

Each module has a single responsibility; `index.ts` and `tui.tsx` are the two
entrypoints (server plugin and TUI plugin respectively).

| Module | Responsibility |
|--------|----------------|
| `config.ts` | Plugin option normalization and resolution; base-URL normalization (strips a trailing `/v1`). |
| `gateway-url.ts` | Gateway URL precedence resolution (`ACTSIS_LITELLM_URL` env > plugin options tuple > stored plugin state > interactive prompt) and stored-credential origin helpers, plus http->https scheme upgrade. |
| `client.ts` | LiteLLM CLI-auth gateway client: discovery fetch with contract validation (`contract_version: 1`, `S256`), dynamic client registration, authorization-code exchange, refresh grant with rotation, token revocation, `/v1/models` + `/v1/model/info` + paginated `/v2/model/info` fetches — all with per-request timeouts. |
| `pkce.ts` | PKCE S256 verifier/challenge generation and random `state` generation. |
| `oauth.ts` | The SSO login orchestration: loopback callback server (`127.0.0.1`, ephemeral port, 5-minute window), callback param parsing/state validation, and the full authorize flow returning an OpenCode-compatible OAuth result. |
| `state.ts` | Schema-versioned plugin state file (`~/.local/share/opencode/actsis-litellm/state.json`) with atomic writes (tmp + rename); stores non-secret gateway metadata, the last budget snapshot, and `budgetRefreshedAt`. |
| `catalog-cache.ts` | Model cache persistence (schema v2) at `~/.local/share/opencode/actsis-litellm/models-cache.json` with atomic writes, cache-age computation, and stale-cache re-sync. |
| `catalog.ts` | Catalog discovery and mapping: `/v1/models` enrichment from `/v1/model/info` (paginated `/v2/model/info` fallback, up to 5 pages of 100), chat-mode filter, and OpenCode `ModelV2` mapping (per-million cost fields, cost tiers above 128k/200k/272k/512k, 128000/16384 context/output defaults). |
| `plugin.ts` | Plugin core: builds the `Hooks` object — `config` hook (provider injection + command templates), `auth` hook (SSO + API-key methods and the per-request credential loader), `provider.models` hook, `event` hook (`session.idle` budget snapshot refresh), `chat.headers`, and `chat.params`. |
| `tools.ts` | Diagnostic tools (`actsis_litellm_status`, `actsis_litellm_models`, `actsis_litellm_logout`, `actsis_litellm_budget`) built on the plugin closure. |
| `auth-store.ts` | Read/clear helpers for credential entries in OpenCode's `auth.json` credential store. |
| `budget.ts` | Budget info fetch and formatting: spend/max/reset info, usage percent, the 8-cell `▰`/`▱` gauge (`budgetGauge`), and the status line (`formatBudgetStatus`). |
| `budget-widget.ts` | Widget-side rendering: reads the persisted snapshot from the plugin state file and computes the display line (returns `null` when there is nothing trustworthy to show). |
| `limit-errors.ts` | Gateway error normalization: parses structured limit errors, classifies 429 responses into budget-exceeded vs throttling, and formats actionable messages with reset times. |
| `overflow.ts` | Detects context-window overflow error messages so they can be prefixed with `context_length_exceeded` for OpenCode's compaction logic. |
| `tui.tsx` | TUI plugin entrypoint (`@opentui/solid` JSX): registers the `sidebar_footer` slot rendering the budget gauge, refreshed on startup and `session.idle` with a 2-second debounce. |
| `index.ts` | Server plugin entrypoint: wraps the plugin factory, wires the tool definitions into `hooks.tool`, and exports the factory as both default and `server` named export. |

### How they compose

- **Server side:** `index.ts` -> `plugin.ts` builds the hooks. `plugin.ts`
  composes `config.ts`/`gateway-url.ts` (URL resolution), `client.ts` +
  `oauth.ts` + `pkce.ts` (login), `catalog.ts` + `catalog-cache.ts`
  (models), `tools.ts` (diagnostics), `limit-errors.ts` + `overflow.ts`
  (error hardening), `auth-store.ts` (credentials), and `budget.ts` +
  `state.ts` (budget snapshot persistence on `session.idle`).
- **TUI side:** `tui.tsx` is a separate entrypoint that shares only
  `budget-widget.ts` (snapshot reading + line formatting) and the state file
  with the server plugin. It never performs network calls.

## OpenCode integration

### Hooks used

| Hook | Purpose |
|------|---------|
| `config` | Injects the provider into the OpenCode config: registers the `@ai-sdk/openai-compatible` provider entry with the catalog models, and merges the `/actsis-litellm-*` command templates into `config.command`. |
| `auth` | Declares the provider (`actsis-litellm`), the login methods (SSO + API key), and the per-request credential `loader`. |
| `provider.models` | Live catalog refresh for the provider's model list. |
| `event` | Listens for `session.idle` (end of an agent turn) to refresh and persist the budget snapshot in the background. |
| `tool` | Registers the diagnostic tools. |
| `chat.headers` | Adds `X-Litellm-Session-ID` for requests targeting the plugin's provider. |
| `chat.params` | Normalizes the `thinking` option into `{ type: "disabled" }` / `{ type: "adaptive" }` before the request reaches the gateway. |

### Credential and file layout

| Store | Location | Contents |
|-------|----------|----------|
| OpenCode credential store | `~/.local/share/opencode/auth.json` | OAuth tokens (access/refresh/expires) or API key. Written and managed by OpenCode; the plugin only reads/clears entries. |
| Plugin state file | `~/.local/share/opencode/actsis-litellm/state.json` | Non-secret gateway metadata (gateway URL, discovery snapshot, client ID, auth mode) plus the last budget snapshot (`lastBudgetSnapshot`) and `budgetRefreshedAt`. |
| Models cache | `~/.local/share/opencode/actsis-litellm/models-cache.json` | Cached model catalog, schema **v2** (stale caches are re-synced automatically). |

### Provider registration shape

The `config` hook injects a provider entry that uses the
`@ai-sdk/openai-compatible` npm package, with the gateway as `baseURL` and
the model list from the catalog sync. Models come from the cache when it is
fresh (within `catalogTtlMinutes`) or from a live sync otherwise; a failed
live sync falls back to the cache.

### Auth loader contract

The `auth.loader` hook receives `{ apiKey, baseURL, fetch }` for each
request:

- Injects the `Authorization: Bearer` header (API key or OAuth access token).
- Performs **proactive refresh** when the access token is within 300 seconds
  of expiry, handling **refresh-token rotation** (the gateway returns a new
  refresh token on each renewal).
- Persists rotated credentials via `client.auth.set({ path: { id }, body:
  { type: "oauth", ... } })` so OpenCode stores the new tokens.
- API-key credentials never refresh; the loader simply injects the key.

## Packaging / TUI-loader contract

OpenCode installs npm/git packages with `--ignore-scripts`, so the compiled
`dist/` bundles are **committed to the repository**; a `prepack` build never
runs on the user's machine. After changing `src/`, run `npm run build` and
commit the regenerated `dist/`.

The TUI loader resolves npm/git packages only through the entrypoint
contract:

- `main` -> `./dist/tui.js` (with the `"."` export mapping to the same file),
- object-form `exports`:
  - `"."` -> `dist/tui.js`,
  - `"./server"` -> `dist/index.js` (server plugin),
  - `"./tui"` -> `dist/tui.js` (TUI widget).
- Raw `src/*.tsx` entrypoints are skipped silently by the loader.

The universal transform (esbuild-plugin-solid, `{ moduleName:
"@opentui/solid", generate: "universal" }`) compiles the Solid JSX for both
server and TUI targets, which is why a single committed bundle serves both
entrypoints. Peer packages `@opentui/core`, `@opentui/solid`, and `solid-js`
are needed only for building from source (devDependencies).

## Budget snapshot lifecycle

1. **Persist (server plugin).** On `session.idle` (end of an agent turn) the
   `event` hook refreshes the budget from the gateway and stores the snapshot
   (`lastBudgetSnapshot` + `budgetRefreshedAt`) in the plugin state file.
   Failures are silent — the tools can force a fresh fetch.
2. **Read (tools).** `actsis_litellm_status` and `actsis_litellm_budget`
   report the live value when the gateway is reachable; when a live fetch
   fails, they fall back to the last cached snapshot and report the precise
   failure reason (no credential, gateway URL not configured, credential
   rejected, network/timeout error).
3. **Read (TUI widget).** `tui.tsx` (id `actsis-litellm-budget`) reads the
   snapshot from the state file at startup and re-reads it on `session.idle`
   (with a 2-second debounce so the server-side write wins the race),
   rendering the gauge line in the `sidebar_footer` slot. It renders nothing
   when there is no data.
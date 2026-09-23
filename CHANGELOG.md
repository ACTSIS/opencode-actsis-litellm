# Changelog

## Unreleased

### Changed

- **Tools and commands renamed to the actsis-litellm namespace** —
  `litellm_status` -> `actsis_litellm_status`, `litellm_models` ->
  `actsis_litellm_models`, `litellm_logout` -> `actsis_litellm_logout`
  (slash commands `/actsis-litellm-status`, `/actsis-litellm-models`,
  `/actsis-litellm-logout`); provider display name "ACTSIS LiteLLM" ->
  "Actsis LiteLLM" (mirrors pi-provider-litellm 052c9ca).

### Fixed

- **API key no longer requested twice during `opencode auth login`** — for the
  API-key method, the plugin now relies on OpenCode's native "Enter your API
  key" prompt and only declares the gateway URL prompt. The key is stored by
  OpenCode in its credential store and validated by the gateway on first use
  (the plugin no longer pre-validates it against `GET /v1/models` at login).

## 0.1.0

Initial release. OpenCode plugin that adds an ACTSIS LiteLLM gateway as a
dynamic model provider, ported from the pi-provider-litellm extension.

### Added

- **Scaffold and package metadata** — `package.json` (`exports` pointing at
  TypeScript source for the Bun runtime, `files` limited to `src/README/
  LICENSE/CHANGELOG`, `engines.opencode >= 1.14.0`), `tsconfig.json`,
  `vitest.config.ts`, MIT `LICENSE`, and repo hygiene (`.gitignore`).
- **Config module** (`src/config.ts`, `src/gateway-url.ts`) — gateway URL
  resolution with `env ACTSIS_LITELLM_URL > plugin options > stored state >
  interactive prompt` precedence, base-URL normalization (trailing `/v1`
  stripped), and stored-credential origin helpers.
- **LiteLLM client** (`src/client.ts`) — discovery fetch with contract
  validation (`contract_version: 1`, `S256`, same-origin, scheme-upgrade
  adaptation), dynamic client registration, token exchange, refresh grant with
  rotation, token revocation, `/v1/models` and `/model/info` fetches, and
  budget info fetch — all with redirect-guard and per-request timeouts.
- **OAuth2 PKCE login** (`src/pkce.ts`, `src/oauth.ts`) — PKCE S256 + random
  state, loopback callback server on `127.0.0.1` (ephemeral port, 5-minute
  window), SSO authorize flow returning an OpenCode-compatible OAuth result,
  and an API-key method validated against `/v1/models` before storage.
- **State and catalog cache** (`src/state.ts`, `src/catalog-cache.ts`) —
  schema-versioned, atomically-written (tmp + rename) state file at
  `~/.local/share/opencode/actsis-litellm/state.json` and models cache at
  `~/.local/share/opencode/actsis-litellm/models-cache.json`.
- **Catalog discovery and mapping** (`src/catalog.ts`) — `/v1/models` +
  `/model/info` enrichment, chat-mode filter (metadata plus conservative name
  heuristic excludes embedding/whisper/TTS/rerank/audio/moderation models),
  and OpenCode `ModelV2` mapping with per-million cost fields and
  128000/16384 context/output defaults.
- **Plugin core** (`src/plugin.ts`, `src/index.ts`) — `config` hook injecting
  the `@ai-sdk/openai-compatible` provider with catalog models and
  `/litellm-*` command templates; `auth` hook with SSO + API-key login methods
  and a loader providing `{ apiKey, baseURL, fetch }` with Bearer injection,
  proactive refresh persisted via `client.auth.set`, and gateway error
  classification; `provider.models` hook for live catalog refresh;
  `chat.headers` (`X-Litellm-Session-ID`) and `chat.params` (`thinking`
  normalization) hooks.
- **Tools and auth-store** (`src/tools.ts`, `src/auth-store.ts`) —
  `litellm_status`, `litellm_models`, `litellm_logout` tools (plus matching
  `/litellm-status`, `/litellm-models`, `/litellm-logout` commands) and
  helpers to read/clear credential entries in OpenCode's `auth.json`.
- **Budget and limit/overflow normalization** (`src/budget.ts`,
  `src/limit-errors.ts`, `src/overflow.ts`) — budget info fetch and formatting
  (spend, max, reset time), 429 classification into budget-exceeded vs
  throttling with actionable messages, and `context_length_exceeded`
  prefixing so OpenCode compaction can react.
- **Documentation** — public-safe `README.md` (install, login, configuration
  precedence, auth methods, catalog, tools/commands, error hardening,
  troubleshooting, security notes) and `docs/login-flow.md` with the full
  OAuth2 PKCE sequence.
- **Tests** — 13 vitest files, 160 tests covering config resolution, client
  contract validation, PKCE/login flow, state and cache, catalog mapping and
  filtering, plugin hooks, tools, auth-store, budget, and limit/overflow
  classification (mocked `fetch`; no network in tests).

### Notes

- Public-safe distribution: only `https://your-gateway.example.com`
  placeholders; no internal hosts, IPs, tokens, or usernames in committed
  files.
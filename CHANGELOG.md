# Changelog

## 0.1.0

- Initial scaffold and package metadata.
- Ported config module (`env > options > stored > prompt` precedence) and gateway URL helpers.
- OpenCode plugin factory (`src/plugin.ts`) wired to the SDK:
  - config hook injects the `@ai-sdk/openai-compatible` provider, models from cache/discovery, and `/litellm:*` command templates.
  - auth hook provides SSO OAuth2 PKCE and API key login methods, plus a loader that injects Bearer tokens, refreshes expiring OAuth credentials, and classifies gateway budget/throttle/overflow errors.
  - provider.models hook refreshes the catalog live.
  - chat.headers hook adds `X-Litellm-Session-ID` parity.
  - chat.params hook normalizes `thinking` options.
- Tool definitions (`src/tools.ts`): `litellm_status`, `litellm_models`, `litellm_logout`.
- Auth-store helpers (`src/auth-store.ts`) to read/clear entries from `~/.local/share/opencode/auth.json`.
- Re-exported the factory from `src/index.ts` as both the named `server` export and the default export for local-directory loading.

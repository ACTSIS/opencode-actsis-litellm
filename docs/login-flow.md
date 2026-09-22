# Login flow sequence

The `actsis-litellm` provider uses OpenCode's `auth` hook to implement a
`/login`-style OAuth2 PKCE flow. All network URLs use placeholders such as
`https://your-gateway.example.com`; no real hostname or token is committed.

## Steps

1. **Prompts.** You run `opencode auth login` and select `actsis-litellm`.
   - The **gateway URL prompt** appears only when the URL is not already
     resolved from the `ACTSIS_LITELLM_URL` environment variable, plugin
     options, or stored plugin state (input is validated as an `http(s)` URL).
   - The **sign-in method selector** asks for **SSO (browser)** or **API key**.
2. **Authorize (SSO path).**
   1. **Discovery** — the plugin fetches `/.well-known/litellm-cli-auth` from
      the gateway and validates the contract (`contract_version: 1`, `S256`
      challenge method required). If the gateway advertises an `http://`
      endpoint, the plugin upgrades it to `https://` and remembers the upgrade.
   2. **Dynamic client registration** — a public OAuth client is registered
      against the discovery `registration_endpoint` (loopback-only redirect).
   3. **PKCE** — a random `code_verifier` is generated and hashed (S256) into
      a `code_challenge`; a random `state` parameter protects the callback.
   4. **Browser** — OpenCode opens the authorization URL. You authenticate
      through your identity provider.
3. **Loopback callback.** The gateway redirects to
   `http://127.0.0.1:<ephemeral port>/callback?code=...&state=...`. A local
   server bound to `127.0.0.1` captures the code, validates `state`, and the
   5-minute window closes.
4. **Token exchange.** The plugin exchanges the authorization code (with the
   PKCE verifier) at the token endpoint for an access token and refresh token.
5. **Credential persistence (OpenCode).** The plugin returns
   `{ type: "success", refresh, access, expires }`; OpenCode persists the
   OAuth credentials in `~/.local/share/opencode/auth.json`.
6. **Plugin state file.** The plugin records a gateway discovery snapshot —
   gateway URL, provider ID, client ID, token/revocation endpoints, resource,
   auth mode, and scheme-upgrade flag — in
   `~/.local/share/opencode/actsis-litellm/state.json`.
7. **Loader (per request).** The `auth.loader` hook provides
   `{ apiKey, baseURL, fetch }` for each request:
   - injects the `Authorization: Bearer` header (API key or access token);
   - performs **proactive refresh** when the access token is within a 300-second
     margin of expiry, handling **refresh-token rotation** (the gateway returns
     a new refresh token on each renewal);
   - persists refreshed credentials via
     `client.auth.set({ path: { id }, body: { type: "oauth", ... } })`.

## Flow diagram

```
opencode auth login
        │
        ▼
[1] Prompts ── gateway URL (only when not configured) ──▶ method: SSO / API key
        │
        ├────────────── SSO (browser) ──────────────┐        API key
        ▼                                            │        │
[2] Discovery        GET /.well-known/litellm-cli-auth        │
        ▼                                            │        ▼
[2] Dynamic client registration (public, loopback)   │   Validate key
        ▼                                            │   GET /v1/models
[2] PKCE S256 + random state                         │        │
        ▼                                            │        │
[2] OpenCode opens browser ── user signs in ─────────┘        │
        ▼                                                     │
[3] Loopback callback  127.0.0.1:<ephemeral>/callback         │
    code + state captured, state validated (5-min window)     │
        ▼                                                     │
[4] Token exchange  code + verifier ──▶ access + refresh      │
        ▼                                                     │
[5] OpenCode persists OAuth credentials (auth.json) ◄─────────┘
        ▼
[6] Plugin state file  gateway snapshot (no tokens)
        ▼
[7] Loader per request  Bearer injection · proactive refresh · rotation
    · persists via client.auth.set
```

## API key path

1. You are prompted for a LiteLLM API key (`sk-...`).
2. The key is validated against `GET /v1/models` (401 → rejected).
3. The plugin writes `authMode: "api_key"` into the plugin state file and
   returns a synthetic long-lived credential so OpenCode treats it like any
   other credential.

## Refresh rotation

For SSO credentials the `auth.loader` hook is invoked before each request. When
`expires` is within a 300-second margin, the loader:

1. Reads refresh state (token endpoint, client ID, resource) from the plugin
   state file.
2. Exchanges the `refresh_token` for a new `access_token` and a rotated
   `refresh_token`.
3. Calls `client.auth.set({ path: { id }, body: { type: "oauth", refresh,
   access, expires } })` so OpenCode persists the new tokens.
4. Uses the new access token for the in-flight request.

API-key credentials never refresh; `auth.loader` simply injects the API key as
a `Bearer` header.

## Logout

`/litellm-logout` (or the `litellm_logout` tool):

1. Revokes the refresh token at the gateway's revocation endpoint (best
   effort; network failures are tolerated because the token expires locally).
2. Clears the credential entry from OpenCode's `auth.json` via the auth-store
   helper.
3. Resets the plugin state file and removes the model cache file.

## Security notes

- The loopback callback server only binds to `127.0.0.1` and only handles a
  single `/callback` request.
- Pending callbacks are buffered and matched by the original `state` parameter.
- PKCE uses an `S256` code challenge and a random `state` to prevent CSRF and
  authorization-code interception.
- The plugin does not store tokens itself; credentials live in OpenCode's
  credential store, and the plugin state file holds only non-secret metadata.
- All placeholder URLs in this document are public-safe.
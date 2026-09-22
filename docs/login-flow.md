# Login flow sequence

The `actsis-litellm` provider uses OpenCode's `auth` hook to implement a
`/login`-style OAuth2 PKCE flow. All network URLs use placeholders such as
`https://your-gateway.example.com`; no real hostname or token is committed.

## Sequence

```
User
 |
 v
OpenCode auth hook: methods[actsis-litellm]
 |
 +-- prompts (gateway URL) --------------+
 |   only when URL is not resolved by      |
 |   env / plugin options / stored state   |
 +-----------------------------------------+
 |
 v
Select auth method: SSO (browser) or API key
 |
 +----------------+   +-----------------+
 | SSO path         |   | API key path     |
 |                  |   |                  |
 | 1. Discovery     |   | 1. Prompt key    |
 |    GET {gateway} |   |                  |
 |    /.well-known  |   | 2. Validate key  |
 |    /litellm-cli-auth |  GET /v1/models |
 |                  |   |                  |
 | 2. Register      |   | 3. Persist state |
 |    client        |   |    authMode=api_key|
 |                  |   |                  |
 | 3. PKCE generate |   | 4. OpenCode stores |
 |    code_verifier |   |    synthetic OAuth |
 |    code_challenge|   |    credential      |
 |                  |   |                  |
 | 4. Browser opens |   |                  |
 |    authorize URL |   |                  |
 |                  |   |                  |
 | 5. Gateway       |   |                  |
 |    redirects to  |   |                  |
 |    127.0.0.1:port|   |                  |
 |    /callback?code&state                |
 |                  |   |                  |
 | 6. Loopback server|  |                  |
 |    captures code |   |                  |
 |    validates state                  |   |
 |                  |   |                  |
 | 7. Token exchange|   |                  |
 |    code -> access|   |                  |
 |    + refresh     |   |                  |
 |                  |   |                  |
 +------------------+   +------------------+
 |
 v
Persist plugin state file:
  gatewayUrl, discovery, clientId, authMode, schemeUpgrade
 |
 v
Return {type: "success", refresh, access, expires}
 |
 v
OpenCode stores credentials in ~/.local/share/opencode/auth.json
```

## Refresh rotation

For SSO credentials the `auth.loader` hook is invoked before each request. When
`expires` is within a 300-second margin, the loader:

1. Reads refresh state from the plugin state file.
2. Exchanges the `refresh_token` for a new `access_token` and a rotated
   `refresh_token`.
3. Calls `client.auth.set({path: {id}, body: {type:"oauth", refresh, access,
   expires}})` so OpenCode persists the new tokens.
4. Updates the plugin state file with the new gateway snapshot if it changed.

API-key credentials never refresh; `auth.loader` simply injects the API key as a
`Bearer` header.

## Security notes

- The loopback callback server only binds to `127.0.0.1` and only handles a
  single `/callback` request.
- Pending callbacks are buffered and matched by the original `state` parameter.
- PKCE uses `S256` code challenge and a random `state` to prevent CSRF and
  authorization-code interception.
- The plugin does not store tokens itself; credentials live in OpenCode's
  credential store.
- All placeholder URLs in this document are public-safe.

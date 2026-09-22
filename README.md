# opencode-actsis-litellm

An [OpenCode](https://opencode.ai) plugin that adds an **ACTSIS LiteLLM
gateway** as a dynamic model provider.

It supports the native `/login` flow using OAuth2 PKCE, discovers the gateway's
model catalog at runtime, and routes chat requests through the OpenAI-compatible
`/v1/chat/completions` endpoint.

## Install

Add the plugin to your OpenCode configuration (for example,
`~/.config/opencode/opencode.json`):

```json
{
  "plugin": ["git:github.com/ACTSIS/opencode-actsis-litellm"]
}
```

For local development use a path to this repository:

```json
{
  "plugin": ["/home/you/Workspace/opencode-actsis-litellm"]
}
```

## Configuration

Zero-config by default. Run `/login`, select `actsis-litellm`, enter the
gateway base URL, and choose how to sign in.

For non-interactive or headless setups you can still configure the gateway via:

1. Environment variable:
   ```bash
   export ACTSIS_LITELLM_URL=https://your-gateway.example.com
   ```
2. Plugin options in `opencode.json`:
   ```json
   {
     "plugin": [
       "git:github.com/ACTSIS/opencode-actsis-litellm",
       {
         "url": "https://your-gateway.example.com",
         "providerId": "actsis-litellm",
         "catalogTtlMinutes": 15,
         "requestTimeoutMs": 30000
       }
     ]
   }
   ```
3. Stored plugin state saved after a previous login.

Only `url` is required in the options object. When no URL is configured at
startup, the provider is still registered with a placeholder so that `/login` can
prompt you for the URL interactively.

## Commands

| Command | Description |
|---------|-------------|
| `/login` | OpenCode's native login flow. Once this provider is registered, select `actsis-litellm` to authenticate. |
| `/litellm:status` | Show credential state, cache age, and provider status. |
| `/litellm:models` | Force a fresh model catalog sync and show added/removed models. |
| `/litellm:logout` | Revoke the refresh token and clear local credentials. |

## Login flow

When you run `/login` and pick `actsis-litellm`:

1. **Gateway URL prompt** — If the gateway URL is not already configured, the
   plugin asks you for it (for example `https://your-gateway.example.com`).
2. **Sign-in method** — Choose **SSO (browser)** or **API key**.
3. **SSO path (browser):**
   - **Discovery** — The plugin fetches `/.well-known/litellm-cli-auth` from the gateway.
   - **Dynamic client registration** — A public, loopback-only OAuth client is registered.
   - **PKCE S256** — A local `code_verifier` is generated and hashed into a `code_challenge`.
   - **Browser consent** — Your browser opens the authorization URL. The gateway authenticates you and shows a team/role picker.
   - **Loopback callback** — The gateway redirects to `http://127.0.0.1:<ephemeral>/callback` with an authorization `code` and the original `state`.
   - **Token exchange** — The plugin validates `state` and exchanges the `code` for an `access_token` and a `refresh_token`.
4. **API key path:**
   - You are prompted for a LiteLLM API key (`sk-...`).
   - The key is validated against `GET {gateway}/v1/models`.
   - A long-lived synthetic credential is stored so OpenCode treats it like any other OAuth credential.
5. **Credential storage** — OpenCode stores the resulting credentials in its own
   auth file under `~/.local/share/opencode/auth.json`.
6. **Refresh rotation** — For SSO, every access-token renewal returns a new
   `refresh_token`; the plugin updates the stored credentials automatically. API
   key credentials do not refresh.
7. **Logout** — `/litellm:logout` clears local state and, for SSO, sends the
   `refresh_token` to the gateway's revoke endpoint.

For a detailed sequence diagram and security rationale, see
[`docs/login-flow.md`](docs/login-flow.md).

## Model catalog

The provider's model list is synced from the gateway at `/v1/models` and
enriched with details from `/model/info` when available.

- **Cache location:** `~/.local/share/opencode/actsis-litellm/models-cache.json`
- **Default TTL:** 15 minutes (`catalogTtlMinutes`)
- **Force sync:** Run `/litellm:models`
- **Cost mapping:** LiteLLM input/output costs are mapped to OpenCode cost fields
  per 1 million tokens. Missing or zero values default to `0`.
- **Context defaults:** `context` and `output` limits default to `128000` and
  `16384` when the gateway does not report them.

## Troubleshooting

| Symptom | What to check |
|---------|---------------|
| Gateway URL not configured | Run `/login`, pick `actsis-litellm`, and enter the gateway URL. Optional: set `ACTSIS_LITELLM_URL` or add `url` to the plugin options in `opencode.json`. |
| Credentials rejected by the gateway | For SSO, run `/login` again to obtain fresh tokens. For API key, check the key in the gateway UI and re-run `/login`. |
| Refresh refused (`invalid_grant`) | The SSO refresh token may be expired, rotated by another client, or revoked. Run `/login` again. |
| "Login cancelled" | The prompt or method selector was dismissed. Re-run `/login` and complete all steps. |
| "Login timed out" | The loopback callback window is 5 minutes. If the browser step takes longer, restart `/login`. |
| Models do not appear | Run `/litellm:models` to force a sync, then check `/litellm:status` for cache count and provider state. |

## Security notes

- The callback server binds to `127.0.0.1` on an ephemeral port only.
- No gateway URL, hostname, IP, token, or user-identifiable data is embedded in
  the package.
- Token storage is delegated to OpenCode's credential store; the plugin itself
  does not write credentials to disk.
- API keys are validated before storage but are otherwise stored by OpenCode like
  any other credential.

## License

MIT — see [`LICENSE`](LICENSE).

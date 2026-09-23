# opencode-actsis-litellm

An [OpenCode](https://opencode.ai) plugin that adds an **Actsis LiteLLM
gateway** as a dynamic model provider with OAuth2 PKCE sign-in (SSO), optional
API-key auth, and a dynamic model catalog.

It hooks into OpenCode's native `/login` flow, discovers the gateway's model
catalog at runtime, and routes chat requests through the OpenAI-compatible
`/v1/chat/completions` endpoint.

## Install

Add the plugin to your OpenCode configuration (for example,
`~/.config/opencode/opencode.json`):

```json
{
  "plugin": ["git:github.com/ACTSIS/opencode-actsis-litellm"]
}
```

Depending on your OpenCode version, the `github:` shorthand is also accepted:

```json
{
  "plugin": ["github:ACTSIS/opencode-actsis-litellm"]
}
```

Once the package is published to npm, the plain package name works too:

```json
{
  "plugin": ["opencode-actsis-litellm"]
}
```

For local development, point the plugin array at a path to this repository:

```json
{
  "plugin": ["/path/to/opencode-actsis-litellm"]
}
```

The plugin ships TypeScript source and runs on the Bun runtime embedded in
OpenCode — no build step is required.

## Login

Start OpenCode and run:

```
opencode auth login
```

1. Select the `actsis-litellm` provider.
2. The **gateway URL** prompt appears when the URL is not already configured
   (see [Configuration](#configuration) for how to set it ahead of time). This
   keeps the plugin zero-config: first-time users are simply asked.
3. Choose a sign-in method:
   - **SSO (browser)** — OAuth2 Authorization Code flow with PKCE (S256). Your
     browser opens, you sign in through your identity provider, and the gateway
     redirects back to a local loopback callback.
   - **API key** — OpenCode itself prompts for the API key ("Enter your API
     key") and stores it in its credential store. The plugin only asks for the
     gateway URL when it is not already configured; the key is validated by
     the gateway on first use (the plugin does not pre-validate it at login).

Credentials are persisted by OpenCode in its own credential store; the plugin
keeps only non-secret gateway metadata in its state file (see
[Security notes](#security-notes)).

## Configuration

Zero-config by default. The gateway base URL is resolved with the following
precedence (highest first):

| Priority | Source | Example |
|----------|--------|---------|
| 1 | Environment variable | `export ACTSIS_LITELLM_URL=https://your-gateway.example.com` |
| 2 | Plugin options (tuple form in `opencode.json`) | `["opencode-actsis-litellm", { "url": "https://your-gateway.example.com" }]` |
| 3 | Stored plugin state (written by a previous login) | `~/.local/share/opencode/actsis-litellm/state.json` |
| 4 | Interactive prompt during `opencode auth login` | Gateway URL prompt with validation |

Plugin options use the `[package, options]` tuple form:

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

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `url` | string | — | Gateway base URL. A trailing `/v1` is stripped automatically. |
| `providerId` | string | `actsis-litellm` | Provider ID registered in OpenCode. |
| `catalogTtlMinutes` | number | `15` | Model catalog cache time-to-live in minutes. |
| `requestTimeoutMs` | number | `30000` | Per-request timeout for gateway HTTP calls in milliseconds. |

## Auth methods

| Method | How it works |
|--------|--------------|
| **SSO (browser)** | OAuth2 Authorization Code + PKCE (S256). The plugin fetches `/.well-known/litellm-cli-auth` discovery metadata, performs dynamic client registration, opens the browser, and captures the redirect on a loopback-only callback server (`127.0.0.1`, ephemeral port). The callback window is **5 minutes**. Access and refresh tokens are stored by OpenCode; refresh tokens are rotated on renewal. |
| **API key** | OpenCode prompts natively for the API key ("Enter your API key") and stores it in its credential store. The plugin only declares the gateway URL prompt (asked when the URL is not already configured). The key is validated by the gateway on first use. API-key credentials never expire and are never refreshed. |

## Model catalog

The provider's model list is synced from the gateway at `/v1/models` and
enriched with details from `/model/info` when available.

- **Chat-mode filter** — Non-chat models (embedding, whisper, TTS, rerank,
  transcription, moderation, audio, and similar) are excluded, using per-model
  mode metadata when the gateway reports it and a conservative name heuristic
  otherwise.
- **Cache location:** `~/.local/share/opencode/actsis-litellm/models-cache.json`
- **Default TTL:** 15 minutes (`catalogTtlMinutes`)
- **Force sync:** Use the `actsis_litellm_models` tool or the `/actsis-litellm-models`
  command.
- **Model picker refresh:** OpenCode reads the model list at startup. After a
  catalog sync, **restart OpenCode** to see new models in the picker.
- **Context/output defaults:** `limit.context` and `limit.output` default to
  `128000` and `16384` when the gateway does not report them.
- **Cost mapping:** LiteLLM input/output/cache costs are mapped to OpenCode
  cost fields per 1 million tokens. Missing or zero values default to `0`.
  When `/v1/model/info` fails or is empty the plugin falls back to the
  paginated `/v2/model/info` endpoint (up to 5 pages of 100), and tiered
  input/output pricing above 128k/200k/272k/512k tokens is surfaced as native
  OpenCode cost tiers when the gateway reports it.

## Tools and commands

| Tool | Command | Description |
|------|---------|-------------|
| `actsis_litellm_status` | `/actsis-litellm-status` | Show credential state, catalog cache age/count, gateway URL, and budget info (falls back to the last cached snapshot between turns). |
| `actsis_litellm_models` | `/actsis-litellm-models` | Force a fresh model catalog sync and report added/removed models. |
| `actsis_litellm_logout` | `/actsis-litellm-logout` | Revoke the refresh token (SSO), clear local credentials, state, and cache. |
| `actsis_litellm_budget` | `/actsis-litellm-budget` | Force a budget refresh and report the exact outcome (gauge line or precise failure reason, plus the last known snapshot when the live fetch fails). |

The commands are thin templates that instruct the agent to call the matching
tool and summarize the result, so they work in both the TUI and server mode.

## TUI widget

An optional TUI widget renders the budget gauge in the OpenCode sidebar
footer. Enable it by adding the package (or a local path) to the `plugin`
array of `~/.config/opencode/tui.json`. The widget reads the snapshot
persisted on `session.idle` (and after `actsis_litellm_budget` refreshes it),
refreshing on startup and after each turn. It renders nothing when no budget
data is available and requires a TUI build with plugin support.

### Packaging note

The `dist/` bundles are committed because OpenCode installs git/npm packages
with `--ignore-scripts`; a `prepack` build step never runs. `main` and
`exports` point at the pre-built `dist/*.js` entrypoints (`dist/index.js` for
the server plugin, `dist/tui.js` for the TUI plugin), mirroring the entrypoint
resolution OpenCode's TUI loader performs for npm/git packages. After changing
`src/`, run `npm run build` and commit the regenerated `dist/` files.

## Error hardening

The plugin wraps gateway chat requests and normalizes the two most common
failure modes into actionable messages:

- **Budget exceeded** — Surfaced as `Budget exceeded: $<spend> of $<max> used —
  top up the key budget or wait for the reset.`
- **Throttling (429)** — Surfaced with the rate-limit type and reset time, for
  example `Rate limit reached (tpm). Resets at 14:32 (~3 min). OpenCode will
  retry automatically.` OpenCode retries 429 responses with backoff natively.
- **Context overflow** — Error messages matching context-window overflow
  patterns are prefixed with `context_length_exceeded` so OpenCode's
  compaction logic can react and trim the conversation.

## Troubleshooting

| Symptom | What to do |
|---------|------------|
| Provider not configured / gateway URL missing | Run `opencode auth login`, select `actsis-litellm`, and enter the gateway URL. Or set `ACTSIS_LITELLM_URL` / add `url` to the plugin options. |
| Login timed out | The loopback callback window is 5 minutes. If the browser step took longer, run `opencode auth login` again. |
| Refresh refused (`invalid_grant`) | The SSO refresh token expired, was rotated elsewhere, or was revoked. Log in again. |
| Models not appearing in the picker | Run `/actsis-litellm-models` to force a sync, then restart OpenCode. Check `/actsis-litellm-status` for cache count. |
| Credential rejected by the gateway | For SSO, log in again to obtain fresh tokens. For API keys, verify the key in the gateway UI and log in again — the key is only checked by the gateway on first use, not during login. |

## Security notes

- The OAuth callback server binds to `127.0.0.1` on an ephemeral port only and
  handles a single `/callback` request per login.
- No gateway hostname, IP, token, or user-identifiable data is embedded in the
  package or this repository.
- OAuth credentials and API keys are stored by OpenCode in
  `~/.local/share/opencode/auth.json` — the plugin does not write tokens itself.
- The plugin's own state file, `~/.local/share/opencode/actsis-litellm/state.json`,
  contains only non-secret gateway metadata (gateway URL, discovery snapshot,
  client ID, auth mode). No tokens are stored there.
- No tokens or gateway URLs appear in OpenCode config files.

## License

MIT — see [`LICENSE`](LICENSE).
# Installation guide

This is the authoritative, step-by-step installation guide for the
`opencode-actsis-litellm` plugin (server plugin + TUI budget widget). The
[README](../README.md) keeps a short quick-start; this document is the
complete reference.

All gateway URLs in examples use the public-safe placeholder
`https://your-gateway.example.com` — replace it with your gateway's base URL
when configuring.

## Requirements

- **OpenCode >= 1.14.0** (declared in the plugin's `engines`). The TUI budget
  widget has been verified on OpenCode **1.18.32**.
- **No manual dependency installs.** The plugin runs on the Bun runtime
  embedded in OpenCode. Peer packages such as `@opentui/core`,
  `@opentui/solid`, and `solid-js` are only needed for **building the plugin
  from source** (they are dev dependencies); end users installing from GitHub
  or npm do not install anything by hand. They are declared as **optional**
  peers so the installer does not download them (the OpenCode TUI supplies
  its own `solid-js` / `@opentui/*` runtime to plugins).

## Recommended install: named GitHub spec

Add the package spec to **both** OpenCode configuration files:

1. `~/.config/opencode/opencode.json` — registers the **server plugin**
   (provider, auth, tools, commands):

   ```json
   {
     "plugin": ["opencode-actsis-litellm@github:ACTSIS/opencode-actsis-litellm"]
   }
   ```

2. `~/.config/opencode/tui.json` — registers the **budget widget** for the
   TUI (same spec, separate file):

   ```json
   {
     "plugin": ["opencode-actsis-litellm@github:ACTSIS/opencode-actsis-litellm"]
   }
   ```

To pin a release, append a tag or commit:
`opencode-actsis-litellm@github:ACTSIS/opencode-actsis-litellm#<tag-or-commit>`. Pinning is recommended: changing the pin is also
how you upgrade (see [Updating](#updating)).

### Why the named spec

Do **not** use the bare `github:ACTSIS/opencode-actsis-litellm` or
`git:github.com/ACTSIS/opencode-actsis-litellm` shorthands. OpenCode installs
plugins with npm's Arborist into
`~/.cache/opencode/packages/<spec>/` and, on every start, checks whether
`node_modules/<package-name>` already exists there. A bare git spec carries
no package name, so that check never matches and OpenCode re-runs the git
install (network + `git ls-remote`) on **every** start, in both the server
and the TUI process. Offline or rate-limited, the plugin fails to load. The
`opencode-actsis-litellm@github:...` form gives the name up front, so the
cached install is reused.

### Updating

With a pinned spec, change the `#<tag-or-commit>` in both files and restart
OpenCode: a new spec means a new cache directory and a fresh install. With
an unpinned spec the first install is cached indefinitely; to force an
update, delete the cache directory and restart:

```sh
rm -rf ~/.cache/opencode/packages/opencode-actsis-litellm@github*
```

> **Dual-config requirement:** the `plugin` array lives in two different
> files with two different roles. `opencode.json` alone gives you the
> provider, login, tools, and commands; `tui.json` alone gives you the
> sidebar budget widget. For the full experience, add the spec to **both**.
> This applies to every install method below, not only the GitHub spec.

### Alternatives

The same dual-config rule applies to the other supported spec forms:

- **npm package** (once the package is published to npm):

  ```json
  {
    "plugin": ["opencode-actsis-litellm"]
  }
  ```

- **Local development path** (a clone of this repository):

  ```json
  {
    "plugin": ["/path/to/opencode-actsis-litellm"]
  }
  ```

Use the same spec in `~/.config/opencode/opencode.json` **and**
`~/.config/opencode/tui.json`.

## Login walkthrough

Start OpenCode and run:

```
opencode auth login
```

1. **Select the provider.** Pick `actsis-litellm` (display name
   "Actsis LiteLLM") from the provider list.
2. **Gateway URL prompt (conditional).** The gateway URL is asked **only when
   it is not already resolved**. Resolution precedence (highest first):
   1. `ACTSIS_LITELLM_URL` environment variable
   2. Plugin options tuple in `opencode.json`
   3. Stored plugin state (`~/.local/share/opencode/actsis-litellm/state.json`,
      written by a previous login)
   4. Interactive prompt
3. **Sign-in method.** Choose **SSO (browser)** or **API key**:
   - **SSO** — OAuth2 Authorization Code flow with PKCE (S256). Your browser
     opens, you sign in through your identity provider, and the gateway
     redirects back to a loopback callback (`127.0.0.1`, ephemeral port).
     The callback window is **5 minutes** — complete the browser step within
     that time.
   - **API key** — OpenCode's native prompt ("Enter your API key") captures
     the key directly; the key is never passed to the plugin. The key is
     stored in OpenCode's credential store and is **validated by the gateway
     on first use**, not at login time.

Credentials are persisted by OpenCode in `~/.local/share/opencode/auth.json`.
The plugin keeps only non-secret gateway metadata in
`~/.local/share/opencode/actsis-litellm/state.json`.

## Post-install verification

After installing and logging in, verify each item:

- [ ] **Provider registered** — `actsis-litellm` (display name
      "Actsis LiteLLM") appears in the `opencode auth login` provider list.
- [ ] **Credential + cache visible** — `/actsis-litellm-status` reports the
      credential state (SSO/API key), the gateway URL, and the catalog cache
      age and model count.
- [ ] **Catalog syncs** — `/actsis-litellm-models` performs a fresh sync and
      reports added/removed models.
- [ ] **Model picker refreshed** — OpenCode reads the model list at startup.
      After the first catalog sync, **restart OpenCode** so new models appear
      in the picker.
- [ ] **Budget widget renders** — in the TUI, the budget gauge
      (`▰▰▰▱▱▱▱▱ 42% · $12.40 of $30.00`) appears in the **sidebar footer**
      once budget data exists (the plugin persists a snapshot at the end of
      each turn; the widget renders nothing when there is no data).

## Troubleshooting

| Symptom | What to do |
|---------|------------|
| **Provider missing from `opencode auth login`** | The plugin cache may be empty after a failed or partial install. Delete `~/.cache/opencode/packages/<spec>/` and restart OpenCode so it re-installs and re-registers. |
| **Install fails with `git dep preparation failed`** | You are on a plugin revision older than the `bundle` script rename: npm's git fetcher ran `npm install` on the clone because `package.json` declared a `build` script, and `npm` was not on the `PATH`. Pin a newer revision (or install Node.js/npm), delete the cache directory, and restart. |
| **Plugin re-installs on every start / fails offline** | You are using a bare `github:` / `git:` spec. Switch to `opencode-actsis-litellm@github:ACTSIS/opencode-actsis-litellm` (see [Why the named spec](#why-the-named-spec)). |
| **Budget widget not rendering** | Verify the `tui.json` entry exists. The widget requires a TUI build with plugin support. For a file-plugin fallback (local checkout), OpenCode's TUI loader needs an absolute path whose module default-exports `{ id, tui }` from the compiled bundle (`main` -> `dist/tui.js`); raw `src/*.tsx` entries are not resolved. |
| **Models missing from the picker** | Run `/actsis-litellm-models` to force a sync, check `/actsis-litellm-status` for the cache model count, then **restart OpenCode** (the picker is refreshed at startup). |
| **Login times out** | The SSO loopback callback window is 5 minutes. If the browser step took longer, run `opencode auth login` again. |
| **Refresh refused (`invalid_grant`)** | The SSO refresh token expired, was rotated elsewhere, or was revoked. Log in again with `opencode auth login`. |
| **Credential rejected by the gateway** | API keys are not pre-validated at login; the gateway validates them on first use. Verify the key in the gateway UI and log in again. For SSO, log in again to obtain fresh tokens. |

## Packaging note: why `dist/` is committed

OpenCode installs npm/git packages with `--ignore-scripts`, so a `prepack`
build step **never runs** on the user's machine. Worse, for git specs npm's
fetcher (pacote) runs a full `npm install` of the cloned repository whenever
`package.json` declares any of `build`, `prepare`, `prepack`, `preinstall`,
`install` or `postinstall` — independently of `--ignore-scripts`. That pulls
every dev dependency and requires `npm` on the `PATH`; without it the
install aborts with `git dep preparation failed`. The build script is
therefore named `bundle`, and none of those script names may be added. To make installs work
without any build step, the compiled `dist/` bundles are **committed to the
repository** and regenerated whenever `src/` changes (`npm run bundle`, then
commit the new `dist/`).

The TUI loader resolves npm/git packages only through the package entrypoint
contract: `main` (and the `"."` export) must point at `./dist/tui.js`, with
object-form `exports`:

```json
{
  "main": "./dist/tui.js",
  "exports": {
    ".": { "import": "./dist/tui.js" },
    "./server": { "import": "./dist/index.js" },
    "./tui": { "import": "./dist/tui.js" }
  }
}
```

Raw `src/*.tsx` entrypoints are skipped silently by the loader. If you build
from source, run `npm run bundle` and commit the regenerated `dist/` files
before installing from a local path.
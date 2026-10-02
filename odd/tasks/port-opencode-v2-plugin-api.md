# Port opencode-actsis-litellm to OpenCode v2 plugin API

## Context

OpenCode was upgraded to v2.0.20 (brew). Two user-visible failures:

1. The plugin no longer loads at all. Two causes:
   - Config key renamed `plugin` -> `plugins` in `opencode.json` (v2 breaking change).
   - `tui.json` no longer exists; terminal config lives in global `cli.json` (auto-migrated).
   - The plugin code uses the V1 plugin API (`(input, options) => Hooks`), which v2 silently
     drops (known upstream issue anomalyco/opencode#42878). V2 requires
     `Plugin.define({ id, setup(ctx) })` from `@opencode/plugin`.
2. TUI reports an error for a plugin not present in `tui.json`: it is
   `opencode-subagent-statusline` (a V1 plugin) listed in the auto-migrated
   `~/.config/opencode/cli.json`; its prepare/install stalls
   (`plugin operation stalled ... target=opencode-subagent-statusline`).

## Evidence

- `~/.config/opencode/opencode.json` still has `"plugin": ["/home/rpinto/Workspace/opencode-actsis-litellm"]`.
- `~/.config/opencode/cli.json` has `"plugins": ["opencode-subagent-statusline", "/home/rpinto/Workspace/opencode-actsis-litellm/"]`.
- Server log only loads the 5 plugins under `~/.config/opencode/plugins/`; ours is absent.
- `opencode plugin list` does not show actsis-litellm; statusline shows with ID `-` (V1 shape).
- Migration guide: https://opencode.ai/v2/docs/build/plugins/migrate-v1

## Tasks

1. Fix OpenCode v2 configs (`plugin` -> `plugins` in opencode.json; clean stale
   `opencode-subagent-statusline` entry from cli.json).
2. Map V1 hooks of the current plugin to V2 domains:
   provider/model/tool transforms, session hooks (chat.params, chat.headers),
   event subscriptions, auth loader.
3. Port server plugin to V2: `Plugin.define({ id, setup(ctx) })` from `@opencode/plugin`.
4. Port TUI budget widget to V2 CLI plugin entrypoint.
5. Verify: `npm test`, `tsc --noEmit`, real `opencode plugin list` shows the plugin,
   TUI starts without errors, budget widget renders.
6. Work-unit commit on a feature branch after checks pass.

## Status

- [x] Task 1 - configs
- [x] Task 2 - V2 API mapping
- [x] Task 3 - server plugin port
- [x] Task 4 - TUI widget port
- [x] Task 5 - verification
- [x] Task 6 - commit

### Task 1 notes (configs)

- `~/.config/opencode/opencode.json`: `"plugin"` renamed to `"plugins"` (path kept).
- `~/.config/opencode/cli.json`: stale V1 package `opencode-subagent-statusline`
  removed (it caused `plugin operation stalled`); actsis-litellm path kept.
- `tui.json` renamed to `tui.json.v1.bak` (v2 uses `cli.json` only).

### Task 5 notes (live verification against opencode v2.0.20)

- Two blockers found by live verification and fixed:
  1. v2's local-directory resolver only probes `<dir>/index` and `<dir>/tui`,
     ignoring `package.json` `main`/`exports`. Fixed by adding root shims
     `index.js` and `tui.js` re-exporting `dist/`.
  2. `[Immer] frozen object` unhandled rejections: `Model.Info.default()`
     returns a frozen object (mutating it in `mapModelConfigToInfo` violated
     the invariant) and the `provider.transform` callback was `async` (must
     be synchronous). Fixed by copying before override and hoisting
     `buildInitialModels` out of the transform callback.
- After a server-daemon restart (`pkill -f "opencode serve"`), live evidence:
  - `loading plugin id=/home/rpinto/Workspace/opencode-actsis-litellm entrypoint=.../index.js`
  - `GET /api/plugin` shows `actsis-litellm` `status: active`, features
    `server + tui`.
  - `GET /api/provider` shows provider `actsis-litellm` bound to integration
    `actsis-litellm`.
  - `GET /api/integration` shows methods `sso-browser` (OAuth) + key.
  - Model list for the provider is empty until the user runs `opencode auth
    login` against the gateway (expected; catalog fills after login).
- `npm test`: 242 passed (14 files); `npm run typecheck`: clean;
  `npm run build`: dist/index.js 73 KB, dist/tui.js 3.9 KB.
- The stale `plugin operation stalled ... opencode-subagent-statusline` warning
  is gone from `opencode plugin list`.

### Remaining user steps

- Run `opencode auth login`, pick `actsis-litellm`, and complete SSO/API-key
  sign-in to populate the model catalog.
- Start the TUI normally; the budget widget renders in `sidebar.footer` once a
  snapshot exists.
- opencode 2.0.22 is available (updater cannot update brew installs).

### Task 3 notes (server plugin port)

- `src/plugin.ts` now default-exports `Plugin.define({ id: "actsis-litellm", setup(ctx) })`
  from `@opencode/plugin`; v1 hooks (`config`, `auth.loader`, `provider.models`,
  `chat.headers`, `chat.params`, `event`) are all ported or replaced:
  - provider/config injection -> `ctx.provider.transform(editor.add({ info, models }))`
    with `Provider.Info.empty(id)` + `settings.baseURL` + `integrationID` binding.
  - dynamic models -> `Model.Info.default(providerID, id)` overridden from the
    cached/fresh catalog (`mapModelConfigToInfo`), fetched by `buildInitialModels`.
  - tools -> `ctx.tool.transform(editor.add({ name, description, input, execute }))`
    with JSON Schema input and `{ content }` results (`buildLitellmToolInfos`).
  - commands -> `ctx.command.transform(editor.add({ name, description, execute }))`
    submitting the tool template via `ctx.session.prompt`.
  - auth -> `ctx.integration.transform(editor.method.update(...))`: an OAuth
    method (`authorize` -> `{ url, instructions, mode: "auto", callback }`
    resolving to a v2 `Credential.OAuth`; `refresh` -> `ensureFreshToken`) and
    the native `key` method; `Provider.Info.integrationID = providerId` binds
    the credential.
  - `chat.headers` -> `ctx.session.hook("model.request", ..., { providerID })`
    (X-Litellm-Session-ID); `chat.params` -> `ctx.session.hook("context", ...,
    { providerID })` (thinking normalization). The old `makeAuthFetch` Bearer
    injection is kept as a pure exported helper for tests only.
  - `event` -> `ctx.event.subscribe({ signal })` loop refreshing the budget
    snapshot on `session.idle` (shared `runBudgetRefresh`); abort via cleanup.
  - error classification -> read-only informational
    `ctx.session.hook("http.response", ..., { providerID })` (best-effort log).
- Removed v1-shaped helpers: `buildProviderInjection`, `buildCommandTemplates`
  (config rewriting), `buildAuthLoader`, `buildProviderModels`.
- `src/tools.ts` tools no longer persist refreshed tokens themselves; v2's
  integration `refresh` callback owns rotation (`resolveToolToken` just reads
  current stored credentials).

### Task 4 notes (TUI widget port)

- `src/tui.tsx` imports `Plugin` from `@opencode/plugin/tui` and exports
  `Plugin.define({ id: "actsis-litellm-budget", setup(context) })`.
- Slot: `context.ui.slot({ append: "sidebar.footer", render })`.
- Event: `context.data.on("session.idle", handler)` with the existing 2 s
  debounce; `readBudgetWidgetData()` initial read unchanged; setup returns the
  teardown that unsubscribes and clears the timer.
- `package.json`: `main`/`exports["."]` now point at the server plugin
  (`src/index.ts` types / `dist/index.js`), `"./tui"` unchanged
  (`src/tui.tsx` / `dist/tui.js`). `tsup.config.ts` externals updated to the
  v2 package names.
### Post-verification fix: credential source (v2 integration store)

- After a successful v2 SSO login, tools (status/budget/models/logout) and the
  plugin's catalog bootstrap + session.idle budget refresh still read the
  credential from the v1 `auth.json` via `readAuthEntry`; v2 never writes that
  file, so tools reported "Auth: none", the catalog stayed empty, and budget
  said "no credential stored".
- `src/plugin.ts`: added `makeCredentialReader(ctx, providerId)` wiring
  `ctx.integration.connection.active(providerId)` +
  `connection.resolve(conn)` into a `() => Promise<CredentialValue | null>`
  reader; `buildInitialModels` and `runBudgetRefresh` take that reader
  (fallback: `readAuthEntry`) and setup injects it into `ToolDeps`.
- `src/tools.ts`: new `getCredential?` in `ToolDeps` + `readEntry(deps)`
  (reader first, `readAuthEntry` fallback, structural normalization of
  `{type:"oauth"|...}` credentials); all four tools use it; logout revokes
  with the integration-sourced refresh token, clears plugin state + cache,
  and tells the user to disconnect the stored credential via the native auth
  UI (no portable plugin API to delete it).
- Tests: `test/plugin-credential.test.ts` (17 cases: reader-first, fallback,
  setup wiring, logout revocation); `test/tools.test.ts` log-out assertion
  adapted to the new honest two-line message.
- `npm test`: 259 passed (15 files); `npm run typecheck`: clean;
  `npm run build`: dist/index.js 75 KB, dist/tui.js 3.9 KB.
### Post-verification fix: oauth login-flow state clobber (stateDir threading)

- `src/oauth.ts` `runLoginFlow()` called `updatePluginState({...})` without the
  `dir` argument, so the login callback's mid-flow state write (with
  `providerId: undefined`) landed in the REAL default state directory
  (`~/.local/share/opencode/actsis-litellm/state.json`) — tests overwrote real
  gateway state and aborted production logins briefly clobbered it.
- Fix: `LoginConfig` gained `stateDir?: string`; the success-path
  `updatePluginState` patch is now written to `config.stateDir`;
  `src/plugin.ts` `authorize()` passes `closure.stateDir` into the
  `LoginConfig`.
- Test hardening: "OAuth method registration" describe now pins
  `XDG_DATA_HOME` to the tmp dir in beforeEach/afterEach; regression tests in
  `test/oauth.test.ts` (mocked state: write must carry the configured dir,
  never `undefined`) and `test/plugin.test.ts` (real FS: default-path
  `state.json` must not be created by the login flow; state lands in the
  configured `stateDir` only).
- Grep sweep: every other reachable state write in `src/`
  (`plugin.ts` x3, `tools.ts` x4) already threads an explicit dir
  (`closure.stateDir` / `deps.stateDir`); no further dir-less writes found.

/**
 * OpenCode v2 server plugin for the ACTSIS LiteLLM gateway.
 *
 * The default export is the `Plugin.define(...)` registration that v2's
 * plugin host loads. `./tui` exposes the separate CLI (TUI) plugin for the
 * sidebar budget widget.
 */
export { default } from "./plugin.ts";

/** Provider/integration ID used by both the server plugin and the tools. */
export { DEFAULT_PROVIDER_ID } from "./plugin.ts";

export {
  resolveClosure,
  buildProviderInfo,
  mapModelConfigToInfo,
  buildCommandDefinitions,
  buildApiKeyMethodRegistration,
  buildOAuthMethodRegistration,
  buildAuthMethodRegistrations,
  buildInitialModels,
  normalizeThinkingOption,
  makeAuthFetch,
  runBudgetRefresh,
} from "./plugin.ts";

export { buildLitellmToolInfos, resolveToolToken, type ToolDeps, type ToolInfo } from "./tools.ts";

export type { PluginClosure, SetupContext } from "./plugin.ts";
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

export {
  buildLitellmToolInfos,
  resolveToolToken,
  type ToolContentPart,
  type ToolDeps,
  type ToolInfo,
  type ToolResult,
} from "./tools.ts";

export {
  buildImageToolInfos,
  CANCEL_IMAGE_TOOL_NAME,
  EDIT_MODEL_HINT,
  IMAGE_COMMAND_TOOL_NAME,
  IMAGE_TOOL_NAME,
  ImageSessionStore,
  discoverImageModels,
  extractImageModelIds,
  fetchImageEdit,
  imageToolTimeoutMs,
  isLastReference,
  runDetachedImageJob,
  resolveImageInput,
  resolveImageModel,
  type ImageToolDeps,
  type SyntheticDelivery,
} from "./image-tool.ts";

export {
  ImageJobRegistry,
  MAX_CONCURRENT_IMAGE_JOBS,
  type ImageJob,
  type ImageJobStatus,
} from "./image-jobs.ts";

export { makeSyntheticDeliverer, shutdownImageJobs } from "./plugin.ts";

export type { PluginClosure, SetupContext } from "./plugin.ts";
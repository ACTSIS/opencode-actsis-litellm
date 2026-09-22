import pluginFactory, { ActsisActiveLLMPlugin as ActsisActiveLLMPluginFactory } from "./plugin.ts";
import { buildLitellmTools } from "./tools.ts";
import type { PluginInput, PluginOptions, Hooks, ToolDefinition } from "@opencode-ai/plugin";

/**
 * OpenCode plugin factory for the ACTSIS LiteLLM gateway.
 *
 * Re-exported as the named `server` entry because OpenCode's community
 * plugin loader expects `PluginModule.server`. The default export is the
 * same factory and supports local-directory loading.
 */
export async function ActsisActiveLLMPlugin(input: PluginInput, options?: PluginOptions): Promise<Hooks> {
  const hooks = await ActsisActiveLLMPluginFactory(input, options);
  const tools = buildLitellmTools({
    providerId: hooks.provider?.id ?? "actsis-litellm",
    getState: async () => null, // not used; tools read state directly
    timeout: 30_000,
    input,
  });
  hooks.tool = tools as Record<string, ToolDefinition>;
  return hooks as Hooks;
}

export { ActsisActiveLLMPlugin as server };
export default ActsisActiveLLMPlugin;

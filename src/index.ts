import type { Plugin } from "@opencode-ai/plugin";

/**
 * Minimal placeholder factory so the package loads as an OpenCode plugin.
 * Later tasks will wire the config, auth, tools, and command hooks here.
 */
export default function actsisLiteLLMPlugin(
  _input: Parameters<Plugin>[0],
  _options?: Parameters<Plugin>[1],
): ReturnType<Plugin> {
  return Promise.resolve({});
}

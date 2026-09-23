import { defineConfig } from "tsup";
import { solidPlugin } from "esbuild-plugin-solid";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    tui: "src/tui.tsx",
  },
  format: ["esm"],
  target: "es2022",
  splitting: false,
  dts: false,
  external: ["solid-js", "@opentui/core", "@opentui/solid", "@opencode-ai/plugin"],
  esbuildPlugins: [solidPlugin({ solid: { moduleName: "@opentui/solid", generate: "universal" } })],
  clean: false,
  sourcemap: false,
});
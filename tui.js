// OpenCode v2 resolves local CLI (TUI) plugins by trying `tui.js` at the
// package root. This shim re-exports the built CLI plugin from dist/.
import plugin from "./dist/tui.js";
export default plugin;
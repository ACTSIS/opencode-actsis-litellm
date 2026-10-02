// OpenCode v2 resolves local plugin directories by trying `index.js` at the
// package root; it does not read package.json `main`/`exports`. This shim
// re-exports the built server plugin from dist/.
import plugin from "./dist/index.js";
export default plugin;
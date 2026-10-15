# System timezone parity with Pi
Align OpenCode with delivered Pi PRs #24 and #26; branch `feat/system-timezone-parity`, baseline `e4f41c5`, issue #11.
Delivery: one focused PR (forecast 250–350 authored diff lines, generated bundles excluded); checks: Vitest, TypeScript and tsup.

## Specs
- S1: "Vamos con Issue>rama>Pr>Merge y al finalizar, tenemos que alinear nuestro par outlook-actsis-litellm"; corrected by "Wow, mea culpa, el tuyo es el correcto, opencode-actsis-litellm". Align the confirmed OpenCode pair after the Pi delivery.
- S2: "Encuentro un detalle, pequeño pero no menor, las horas en nuestra librería utilizan UTC, pero deberiamos ajustarnos a la zona horaria del sistema, podemos lograrlo?"; "Revisemos todas la fehcas y horas visibles de la extensión"; "Dale con eso". Apply the approved Pi date-display policy to equivalent OpenCode surfaces.
- S3: "Joven, tenemos que hacer algunos ajustes con los datos del comando /usage-subs. En lugar de mostrar la fecha del reset, que es poco amigable, muestra el tiempo en horas/minutos o en días/horas para ventana de 5 horas y ventana semanal respectivamente." Match the already-delivered Pi countdown behavior.

## Tasks
- T1 → S2-S3 | route: inline | status: in_progress | commit: pending | Implement parity through public formatter/tool tests (RED then GREEN), help/docs and generated bundles; run suite/typecheck/bundle and risk-required verification.
- T2 → S1 | route: inline | status: pending | commit: pending | Deliver the verified T1 unit through approved issue #11, feature branch, PR and merge; preserve unrelated root-checkout changes.

## Log
- L1 (verbatim): "Vamos con Issue>rama>Pr>Merge y al finalizar, tenemos que alinear nuestro par outlook-actsis-litellm"
- L2 (verbatim correction): "Wow, mea culpa, el tuyo es el correcto, opencode-actsis-litellm"
- L3: User explicitly authorized both ACTSIS GitHub targets using the current GitHub CLI session, closing references, approval label with ADMIN/MAINTAIN permission, and sibling repository read/write. Pi issue #25 is CLOSED; PR #26 merged as `6e45b6d`; 308 tests and acknowledged native review passed.
- L4: OpenCode issue #11 is approved and read back; no matching timezone issue or required template found. Worktree baseline `e4f41c5` has no reset countdowns. Original checkout has unrelated `dist/index.js` additions; use this isolated worktree only, never reset/stash/build the original checkout.
- L5: Approved parity policy: local date plus 24-hour time, system IANA timezone and instant-specific UTC offset for generation, credential expiry and budget/throttle resets; keep durations and UTC query arithmetic unchanged, label the latter UTC days. Reset cells use Pi's `H h M min` and `D d H h`, rounded up to displayed precision, clamped at zero; unavailable timestamps show `-`/`never` as appropriate. This is accepted Pi reference behavior, not a new product requirement.
- L6: Committed dist files are runtime entrypoints and must be regenerated in this worktree. Existing root node_modules can supply binaries without network/dependency changes. Native review is an extra outside view and never replaces functional checks; only user-owned mode may enable it.
- L7: RED observed through public formatters/tools: `npm test -- test/local-datetime.test.ts test/plugin-credential.test.ts` exited 1 (5 failed, 16 passed). Failures cover local dates, unavailable generation timestamp, countdown headers/values, UTC range labels and tool OAuth expiry; no source changes preceded RED.
- L8: GREEN focused suite: 7 files, 166 tests passed. Complete suite: 24 files, 439 tests passed; `npm run typecheck` and `git diff --check` exited 0. Help, Spanish README and Unreleased changelog updated. `npm run bundle` completed successfully in background job-7 inside this worktree; generated `dist/index.js`/`dist/tui.js` and diff whitespace checks passed. Risk assessment and any required independent/native verification remain pending; no publication in OpenCode yet.
- L9: Generated index had not contained the existing source subscription tool at baseline; rebuilding includes that already-committed module along with the requested countdown/date changes. This is necessary to ship the source behavior and matches the plugin's committed-dist policy; no credential/authentication logic was changed. Authored diff remains within the forecast (about 275 lines including the feature document, generated bundles excluded).

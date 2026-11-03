# Image generation in background jobs — OpenCode port of pi #61

Detached image rendering so the chat turn is not blocked while the gateway
renders. Opt-in per call; the blocking path stays the default. Ports the
behaviour delivered in `pi-actsis-litellm` (issue #61, `odd/tasks/image-background-jobs.md`)
onto the OpenCode v2 plugin API, which has no `ui.setStatus` and no
per-session shutdown hook.

## Specs

S1 (owner, pi #61 L1): "Un ajuste funcional para la generacion de imagenes,
    podriamos levantar la geenración en un hilo en paralelo, sin ocupar el hilo
    principal del chat?"

S2 (owner, today): port that behaviour to OpenCode with the mapping chosen as
    "Port completo con entrega sintética".

S3: background is opt-in per call. `actsis_litellm_generate_image` takes a
    boolean parameter `background` (default false = today's blocking
    behaviour); the `/image` surface tool `actsis_litellm_image` accepts
    `--background` in its raw args. Waiting stays correct when the model needs
    the result to decide the next step.

S4: a detached call returns immediately with a text that (a) names the job id,
    (b) says the image will appear in the conversation by itself, and (c) tells
    the model NOT to call the tool again for the same prompt.

S5: on success the png is always persisted, the session image store is updated
    at that moment (so `image: "last"` works for the next edit), and the image
    is delivered as a synthetic session message with
    `session.synthetic({ sessionID, text, delivery: "queue", resume: false })`
    whose text carries `![generated image](<file path>)` plus the saved path.
    No image file-part: the synthetic payload is text-only (documented
    deviation from pi S5).

S6: on failure the error is delivered as a synthetic session message too and
    logged with `console.warn`, and the job slot is released.

S7: each detached job owns its own AbortController. The tool-call signal
    belongs to the active turn and is never reused after `execute` returns.

S8: `actsis_litellm_cancel_image` (command surface
    `/actsis-litellm-cancel-image`) aborts `all` or one job id and reports which
    jobs it aborted, saying the render may keep running on the gateway GPU. With
    no argument it lists the in-flight jobs with model, size, elapsed seconds
    and status — this replaces pi's `ui.setStatus` line, which OpenCode's server
    plugin API does not expose (documented deviation from pi S8).

S9: an edit that resolves `image: "last"` while a render of the same session is
    still pending fails with a message that names the pending job id instead of
    an opaque error.

S10: the plugin `dispose` handler aborts in-flight jobs idempotently and the
    user-facing text states that the render may keep running on the gateway GPU.
    It is process-wide (not per session) because the v2 API has no session
    shutdown hook (documented deviation from pi S10).

S11: concurrent detached jobs are capped at 2 process-wide. A call beyond the
    cap is rejected with a message naming the running jobs — the gateway renders
    on a single GPU, so piling up requests only lengthens every wait.

Non-goals: persisting jobs across OpenCode processes; a UI status line; image
file-parts in delivered messages; changing the per-model/size timeouts from
pi #57.

## Tasks

T1 (S1-S3): `src/image-jobs.ts` — job registry (id, model, size, sessionID,
   status, startedAt, AbortController, cap, cancel/cancelAll) + focused tests.
T2 (S3): `background` parameter on `actsis_litellm_generate_image` and
   `--background` in `parseImageArgs` for `actsis_litellm_image`; blocking path
   unchanged (`src/image.ts`, `src/image-tool.ts`, help text).
T3 (S5/S6): detached runner + synthetic delivery through an injected
   `deliverSynthetic` dep; store updated on completion only.
T4 (S8): `actsis_litellm_cancel_image` tool + command template.
T5 (S7/S9/S10/S11): per-job AbortController, pending-`last` guard, dispose
   abort, cap behaviour.
T6 (docs): README, CHANGELOG "Sin publicar", `docs/architecture.md`, bundle.
T7: verification (tests + typecheck + tsup) and delivery.

Route: inline in the parent session — the units are a single coupled compile
unit (the runner calls the registry, the plugin injects both into the tools),
so there is no independent writer unit to parallelise.

## Log

L1 (2026-11-03, owner): "Continuemos con nuestro trabajo pendiente"
L2 (2026-11-03, owner): chose "Port completo con entrega sintética" after being
   shown the four options (full port with synthetic delivery / full port without
   delivery / skip and document the asymmetry / resume another pending item).
L3 (2026-11-03, parent): runtime facts that shape the port.
   - `session.synthetic({ sessionID, text, description?, metadata?, delivery?,
     resume? })` is the only append-without-turn primitive; its payload is
     text-only, so the delivered image is a markdown link + saved path.
   - The server plugin has no notify/status surface; `context.command` and
     `context.tool` are the only user-facing registrations, and `setup` returns
     the single dispose hook.
   - `ToolInfo.execute(input, context)` exposes `context.sessionID` and an
     optional `context.progress`; there is no post-return callback, which is why
     delivery must go through the session API and not through `progress`.
L4 (2026-11-03, parent): implementation records.
   - Cap and job listing are process-wide; the pending-`last` guard is scoped to
     the calling session because the image store is session-keyed.
   - Delivery is skipped (png + `console.warn` only) when the tool call carries
     no session id, so a single-session host never gets a message aimed at a
     synthetic session key.
   - `resume: false` is the lever that keeps the delivery from starting a model
     turn; it is declared in the generated client input type but not documented
     beyond that, so it is listed as an acceptance gap for a real host.
L5 (2026-11-03, parent): verification and slice boundary.
   - Suite 559/559 (was 536; +23 tests), `tsc --noEmit` clean, `tsup` build
     clean (`dist/index.js` 157.38 KB).
   - Slice boundary: two commits, `28d630b` (registry + `--background` parser +
     abort signal, T1/T2) and this one (tools wiring, synthetic delivery, cancel
     surface, plugin dispose, docs, bundle, T3-T7). `dist/` is generated, so the
     authored line count is below the raw diff stat.
   - `gentle_review assess`: risk medium, native assessment unassessable
     (untracked files needed an explicit declaration at assess time), plan
     writer-self-verification with no separate verifier; no high-risk item.
   - Known verification gap (declared, not covered): the plugin `dispose`
     handler itself has no integration test because it is registered inline in
     `setup`; the underlying `cancelAll()` idempotency and the shutdown text are
     covered by `test/plugin.test.ts` (`shutdownImageJobs`).
   - Acceptance gap on a real host: `resume: false` actually keeping the turn
     closed, and the synthetic message rendering the markdown image link.
L6 (2026-11-03, parent): delivery, decided by the owner as "PR + merge + 0.6.5
   pareado en ambos".
   - Issue #42; PR #43 merged into `main` (`2f7cb7c`); review-gated plan from
     `assess` (medium, no reviewDue) applied, so no native review was started:
     the only workspace candidate the controller projected afterwards was the
     regenerated `.vitest/json/output.json`, a test artifact, not the change.
   - Release 0.6.5: branch `release/pair-0.6.5`, commit `23d8888`, PR #44 merged
     (`8956d7f`), annotated tag `v0.6.5` pushed.
   - Paired release in `pi-actsis-litellm`: PR #64 merged (`8edcd90`), annotated
     tag `v0.6.5` pushed; that release carries no functional changes, only the
     shared number.
   - Known verification gaps unchanged: the `session.synthetic` `resume: false`
     behaviour and the markdown image link still need acceptance on a real
     OpenCode >= 2.0.0 host.

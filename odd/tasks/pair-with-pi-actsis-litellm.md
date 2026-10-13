# Feature: pair with pi-actsis-litellm (usage, top-5, TLS, OAuth)

Bring the OpenCode plugin to full parity with the sibling pi extension
`pi-actsis-litellm` (main, suite 286/286). Serves GitHub issue #5
(status:approved). Reference implementation is read-only:
`~/Workspace/pi-actsis-litellm/extensions/lib/{usage,top-widget,tls-config,network-error,commands}.ts`
and its tests under `test/`.

## Allowed edit surfaces
- src/**
- test/**
- README.md
- CHANGELOG.md
- package.json (version bump only)

Constraints: OpenCode idioms (tools return strings, command-template
prompts, no pi-specific APIs); no internal hostnames/keys committed
(E2E uses local state file only); artifacts in English; Conventional
Commits, one work-unit commit per task; tests-first where runnable.

## Tasks

### P1. Usage data layer (aggregated endpoint + pagination fallback) — DONE
- Evidence: commit 69e7e49; src/usage.ts + test/usage.test.ts (40/40 GREEN, RED observed at import failure); typecheck clean; worker task mv1h6xwy-1-quus.
- Port pi `extensions/lib/usage.ts`: `user/daily/activity/aggregated`
  with `user_id` filter from stored credential (dashboard parity —
  stable total in one call); fallback = full pagination walk of the
  classic endpoint, adopting per-page metadata only if one page.
- Unit tests: aggregated shape, pagination fallback, page metadata
  adoption guard. Mirrors pi test/usage.test.ts + usage-credential.
- Acceptance: typecheck + tests green; commit feat(usage).

### P2. Public alias resolution for spend rows — DONE
- Evidence: included in commit 69e7e49 (mapModelAliases / applyModelAliases; exact-id, suffix-after-last-slash, sorted-first on ambiguity, display-time merge).
- Alias `openai/...` internal deployments to public catalog aliases
  (`oc/...`) by exact id or shared suffix after last `/`; merge rows of
  the same public model.
- Unit tests included with P1/P2 suite. Commit feat(usage).

### P3. `/actsis-litellm:usage` command (30d default, N days, `YYYY-MM-DD .. YYYY-MM-DD` window) — DONE
- Evidence: commit feat(usage) on feat/pair-with-pi-actsis-litellm; src/usage-command.ts + tool `actsis_litellm_usage` + plugin command; test/usage-command.test.ts 17 tests; full suite 318/318 green; typecheck clean; worker task mv1hbit1-2-9a4r. (30d default, N days, `YYYY-MM-DD .. YYYY-MM-DD` window)
- Aligned table Model / Spend / Tokens / Reqs, compact token counts,
  Total row, gateway activity note (`gateway/daily/activity` —
  "Total Requests" dashboard source).
- Wire as markdown command + tool answer (same pattern as
  status/models). Commit feat(usage).

### P4. Top-5 widget rows in budget TUI + share gauge — DONE (delivered with P5 as one unit)
- Evidence: commit 3954f9a; plugin→state.json→TUI pipeline with runTopModelsRefresh on session.idle; NBSP padding (pi c03385b port); 8-cell gauge via shared budget gauge; TTL 5 min on the same triggers as the budget widget.
### P5. `top on|off|toggle` persisted preference — DONE (same commit 3954f9a)
- Evidence: src/preferences.ts (preferences.json atomic write, default-on) + src/top-command.ts + tool actsis_litellm_top + command actsis-litellm-top; test/top-widget.test.ts 33 tests; full suite 351/351; typecheck clean; worker task mv1hgrpc-3-ewfk.
- Decision noted: `=` rule spans full rendered row width (one cell longer than pi's), pinned by test; revert to pi-exact is a one-line change.
- `off` clears rows and stops gateway queries; `on` force-refreshes immediately; default on.

### P6. TLS system CA bootstrap — DONE
- Evidence: commit on branch; src/tls-config.ts (configureSystemCa: getCACertificates('system') + setDefaultCACertificates, strictly additive/once-per-session/fail-open, opt-out ACTSIS_LITELLM_NO_SYSTEM_CA=1) wired as first step of plugin setup; tlsTrustRemediationMessage (NODE_USE_SYSTEM_CA, certutil→PEM→NODE_EXTRA_CA_CERTS, --use-openssl-ca/SSL_CERT_FILE per platform); test/tls-config.test.ts 31 + tls-wiring.test.ts 3; suite 385/385; typecheck clean; worker task mv1hpq37-4-uzy5.
- Port pi tls-config: union of Node embedded CAs + system
  certificates (`tls.getCACertificates('system')` +
  `setDefaultCACertificates`, Node >= 22.19.0); additive-once,
  non-blocking, env opt-out; TLS trust error messages with per-platform
  remediation (`NODE_USE_SYSTEM_CA`, PEM conversion for
  NODE_EXTRA_CA_CERTS). Tests: tls-config + wiring. Commit feat(tls).

### P7. Rename visible login label to "OAuth (browser)" — DONE
- Evidence: commit 97df8a0; label "Sign in with OAuth (browser)"; id "sso-browser" and stored-credential identifiers untouched; test/plugin.test.ts pin updated; worker task mv1hzk9x-5-f364.
- Label only; internal identifiers unchanged (stored credential
  compatibility). Update README/CHANGELOG mentions. Commit feat(oauth).

### P8. Root-cause network errors — DONE
- Evidence: commit 827ba18; src/network-error.ts fetchFailureMessage (DNS/refused/TLS/timeout/reset, cause-chain, depth cap) wired at client (7 sites), usage, budget catch sites; TLS slice delegates to tls-config helpers; AuthError now wraps previously-raw TypeErrors from register/exchange/refresh/revoke (pi-parity); test/network-error.test.ts 24 tests; suite 409/409; typecheck clean.
- Follow-up noted (non-blocking): plugin.ts makeAuthFetch response-classification path not in scope per worker; check at review.
- Port pi network-error: detailed transport failure cause (DNS,
  refused, TLS, timeout) instead of opaque `fetch failed` in
  gateway paths. Tests mirror test/network-error.test.ts.
  Commit fix(errors).

### P10. (bugfix, post-delivery) Budget/widget refresh triggers — session.idle never fires in opencode v2 — DONE
- Evidence: commit 16f649c (fix(widget), v0.3.1, dist rebuilt, CHANGELOG entry); src/widget-events.ts shared trigger list (+ TUI 60s poll safety net); test/widget-events.test.ts + extended plugin event-loop test; suite 413/413; worker task mv6q86dw-8-wvl8; pushed to PR #6.
- Symptom: /actsis-litellm:budget (fresh fetch via tool) shows $477.43/80% while the TUI widget stays frozen at an older $336.96/56%.
- Root cause (verified): opencode v2.0.25 turns emit session.execution.succeeded/failed/interrupted; session.idle is deprecated in the schema and NOT emitted (source sst/opencode dev: schema/src/session-status-event.ts marks it deprecated; core publishes only SessionEvent.Execution.*; empirical probe on a local v2.0.25 serve captured session.execution.* but zero session.idle/session.status events).
- Our server loop (src/plugin.ts ~930) and TUI hook (src/tui.tsx) filter exactly "session.idle" → both never fire → widget only shows the TUI-setup-time snapshot.
- Fix plan: shared trigger-list helper (src/widget-events.ts) with session.idle + session.execution.{succeeded,failed,interrupted}; plugin loop and TUI data.on use it; TUI adds a 60s polling safety net on state.json re-read.

### P9. Docs + version bump + E2E gateway verification
- Docs DONE: commits 98d25f5 (docs) + f8a6add (chore(release) 0.3.0 + dist rebuild via npm run bundle); README sections Uso por modelo / Filas Top-5 / TLS con una CA privada; CHANGELOG 0.3.0 entry; suite 409/409; typecheck clean; worker task mv1i5nfu-6-54wh.
- E2E: parent-owned, below.
- README (usage command, top widget, TLS notes, rename),
  CHANGELOG entry, package.json 0.3.0.
- E2E against real gateway using local state-file credentials only:
  usage table vs dashboard (~1% bound), top widget rows, toggle,
  TLS bootstrap. Do not commit any output. Commit docs.
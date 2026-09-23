# Feature: update-documentation

Update the repository's functional, technical, and user documentation to
reflect all shipped changes (through commit c2bfdeb) — with special emphasis
on the **correct public install** of the plugin (server plugin + TUI widget).

## Context

- Public install was solved and fresh-install verified in the prior session
  (commit c2bfdeb): `main` -> `./dist/tui.js`, object-form `exports`, and the
  widget is enabled in a **separate** `tui.json` config.
- `README.md` (208 lines) is mostly current but its TUI widget section
  understates the packaging requirement (`dist/` bundles are mandatory: the
  package ships compiled artifacts because OpenCode installs with
  `--ignore-scripts`), does not mention `@opentui` peer deps, and buries the
  dual-config requirement (opencode.json + tui.json) instead of presenting a
  verified end-to-end install guide.
- `docs/login-flow.md` still references the old `/litellm-logout` and
  `litellm_logout` names (renamed to `/actsis-litellm-logout` /
  `actsis_litellm_logout` in 2f82b3a) and does not mention the post-turn
  budget snapshot or the budget gauge.
- No `docs/architecture.md` exists; technical documentation is spread across
  README sections and the ODD docs.
- `CHANGELOG.md` "Unreleased" documents the changes but no docs entry exists
  for this documentation update itself.

## Goals

1. `docs/installation.md` — authoritative step-by-step install guide:
   prerequisites (OpenCode >= 1.14, recommended 1.18.x verified; runtime deps
   handled by OpenCode's Bun runtime), GitHub spec install, npm-spec, local
   dev path, dual config (server in `opencode.json` + widget in `tui.json`),
   login flow walkthrough, verification checklist, and a troubleshooting
   section including the TUI-loader packaging note and the plugin-cache
   recovery note.
2. `README.md` — restructured: installation section points to
   `docs/installation.md` and includes a quick-start (dual config), TUI
   widget section updated (mandatory `dist/` bundles, `@opentui` peer deps,
   `session.idle` snapshot lifecycle), architecture pointer.
3. `docs/architecture.md` — new technical document: module map
   (config/gateway-url, client, oauth/pkce, state, catalog-cache, catalog,
   plugin, tools, budget, budget-widget, limit-errors, overflow, tui.tsx,
   index/server/tui entrypoints), hooks used, data stores (auth.json, state
   file, models cache v2, budget snapshot fields), provider config shape, and
   the packaging/TUI-loader contract (main -> dist/tui.js, exports map,
   --ignore-scripts, esbuild-plugin-solid universal transform).
4. `docs/login-flow.md` — refresh tool/command names, add budget snapshot on
   `session.idle`, correct any drift vs `src/oauth.ts`/`src/plugin.ts`.
5. `CHANGELOG.md` — Unreleased "Documentation" entry describing this update.

## Non-goals

- No source changes, no version bump, no tag, no npm publish.
- No internal hosts/tokens/usernames in committed docs (public-safe rule).
- No CI/docs pipeline.

## Verification

- `grep -rn "litellm_status|litellm_models|litellm_logout|/litellm-" docs/ README.md` returns zero stale names.
- No internal hosts: only `https://your-gateway.example.com` placeholders.
- Markdown renders coherently (headings, tables, code fences).
- README links resolve to existing files (`docs/installation.md`,
  `docs/architecture.md`, `docs/login-flow.md`).

## Evidence

| Task | Status | Commit | Notes |
|------|--------|--------|-------|
| Writer delegation (docs drafting) | completed | see docs commit | gentle-ai-worker; 5 files changed; deviations: architecture module map also covers errors.ts + gateway-client.ts; historical 0.1.0 changelog names preserved |
| Installation guide + README | completed | see docs commit | docs/installation.md new (requirements, dual-config GitHub/npm/local, login walkthrough, verification checklist, troubleshooting, packaging note); README quick-start + guide link + widget section + Architecture section |
| Technical doc (architecture.md + login-flow refresh) | completed | see docs commit | 17-module map, hooks table, stores layout, loader contract, packaging/TUI-loader contract, budget snapshot lifecycle; login-flow names fixed + post-turn snapshot subsection |
| CHANGELOG entry + verification | completed | see docs commit | "### Documentation" under Unreleased; gentle-ai-verify: stale-names PASS, public-safe PASS, markdown PASS, links PASS, factual spot-checks PASS (6/6) |
| RDD native review | pending | — | gentle_review inspect on the docs work-unit commit |
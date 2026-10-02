# Reescribir toda la documentación en español (post-porteo v2)

## Context

Tras el porteo a OpenCode v2 (release v0.2.0) toda la documentación quedó desactualizada o en inglés. El maintainer pidió: documentación completa en español, con indicaciones claras de instalación/uso, y todo lo funcional y técnico necesario.

## Auditoría del estado actual

- `README.md` — parcialmente v2 pero en inglés; ERROR: dice que credenciales van a `~/.local/share/opencode/auth.json` (en v2 viven en el store nativo de integraciones, opencode.db; auth.json es solo fallback legado).
- `docs/installation.md` — mayormente v2, en inglés, mismo error del credential store.
- `docs/architecture.md` — MUY desactualizado: describe hooks v1 (`config`, `auth.loader`, `provider.models`, `chat.headers`, `chat.params`), no la API v2.
- `docs/login-flow.md` — MUY desactualizado: flujo v1 con `auth.loader`; en v2 es un método de integración con `authorize`/`refresh` callbacks y `Credential.OAuth`.
- `CHANGELOG.md` — v2-actualizado pero en inglés; el maintener pidió TODO en español, incluido el CHANGELOG.

## Referencia técnica v2 verificada (usar como fuente de verdad)

- Plugin: `Plugin.define({ id: "actsis-litellm", setup(ctx) })` desde `@opencode/plugin`; entrypoints raíz `index.js`/`tui.js` (shims) re-exportando `dist/`.
- Auth: método de integración OAuth `sso-browser` con `authorize(answer)` → `{url, instructions, mode: "auto", callback: Promise<Credential.OAuth>}` y `refresh(credential)` vía `ensureFreshToken`; método `key` nativo. Credenciales en el store de OpenCode (opencode.db), leídas por herramientas vía `ctx.integration.connection.active() + resolve()`.
- Provider: `ctx.provider.transform` → `editor.add({info: Provider.Info (package @opencode/ai/providers/openai-compatible, settings.baseURL, integrationID), models: Model.Info[]})`.
- Modelos: catálogo mapeado con `Model.Info.default()` + overrides (limit, capabilities, cost tiers, variants); callback de transform SÍNCRONO (invariante Immer).
- Tools: `ctx.tool.transform` con `editor.add({name, description, input: JSONSchema, execute → {content}})` — 4 herramientas.
- Comandos: `ctx.command.transform` → `editor.add({name, description, execute({sessionID, prompt, delivery})})` — 4 comandos slash vía `ctx.session.prompt`.
- Hooks de sesión con scope `{providerID}`: `model.request` (header X-Litellm-Session-ID), `context` (normalización thinking), `http.response` (clasificación informativa de errores budget/throttle/overflow).
- Eventos: `ctx.event.subscribe({signal})` → `session.idle` dispara `runBudgetRefresh`.
- TUI: CLI plugin `@opencode/plugin/tui`, `Plugin.define({id: "actsis-litellm-budget"})`, `context.ui.slot({append: "sidebar.footer"})`, `context.data.on("session.idle")` con debounce 2s.
- Config v2: clave `"plugins"` en `opencode.json`; widget en `cli.json`; resolver local de directorios ignora `main`/`exports` (por eso los shims raíz).
- Estado: `~/.local/share/opencode/actsis-litellm/state.json` (metadatos no-secretos + budget snapshot) y `models-cache.json` (esquema v2). `runLoginFlow` ahora recibe `stateDir` en `LoginConfig`.
- Verificado en vivo: opencode v2.0.20 contra ai.actsis.internal — OAuth activo, 25 modelos, budget $332.75/$600 (55%).

## Resultado

- Delegado a gentle-ai-worker y verificado por el padre contra `src/` y `package.json`.
- README.md (254 líneas): inicio rápido dual-config, login, configuración con precedencia, auth, catálogo, tools/comandos, widget TUI, arquitectura, hardening de errores, troubleshooting, seguridad,
  licencia + badge.
- docs/installation.md (189): requisitos (≥2.0.0, verificado v2.0.20), GitHub spec dual-config, alternativas, login walkthrough, checklist, troubleshooting, packaging (shims raíz + main/exports).
- docs/architecture.md (177): mapa de módulos v2, transforms/hooks/event loop, stores (opencode.db vs auth.json fallback vs state.json vs models-cache), credential reader, shape del provider,
  invariantes Immer, packaging/loader, ciclo del snapshot.
- docs/login-flow.md (154): flujo v2 completo con Credential.OAuth al store nativo, refresh callback, API key nativa, logout honesto, diagrama ASCII.
- CHANGELOG.md (250): traducción completa al español (0.2.0, Unreleased, 0.1.0).
- Correcciones factuales v1 aplicadas: credenciales viven en el store de integraciones (opencode.db), no auth.json; hooks v1 reemplazados por API v2 (transforms + session hooks + event
  subscribe); shims raíz; slot sidebar.footer; logout y su límite de API.
- Idioma: español neutro/profesional; código/JSON/identificadores en su forma técnica.
- Nota: docs pasivos; no aplica test-first. Verificación por exactitud técnica (spot checks contra src/) y links internos.

## Estado final del feature

- [x] README.md
- [x] docs/installation.md
- [x] docs/architecture.md
- [x] docs/login-flow.md
- [x] CHANGELOG.md
- [x] Verificación técnica + commit
- Commit: pendiente en main (release v0.2.0 ya publicada; este commit es docs-only).

## Nota de proceso
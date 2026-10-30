# Feature: paridad 47/48 — scope de catálogo e imágenes

Réplica en el plugin de OpenCode de lo ya entregado en `pi-actsis-litellm`
(`origin/main` `719093a`) después del release pareado 0.6.3: scope de
credencial/equipo del catálogo (issue pi #48) y generación/edición de imágenes
(issue pi #47 con el tool `generate_image` y sus fixes #53/#55/#56).

## Specs

- S1 (verbatim, usuario): "Tenemos una tarea importante, hemos realizado
  cambios grande en pi-actsis-litellm y debemos replicarlos para opencode,
  revisa el GAP actual".
- S2 (verbatim, usuario, decisión de render): "Spike file-part y si falla,
  markdown con el png".
- S3 (pi #48 S3, verbatim): "Catalog refresh documents which
  credential/scope it uses (login session vs stored API key)."
- S4 (pi #48 S3): la caché guarda kind de auth + userId + teamId (campo
  aditivo del schema v2, lectores viejos tolerados); `status` y `models` lo
  muestran y aparece un hint de re-login cuando hay team y el catálogo es
  solo `oc/*`.
- S5 (pi #48 S4, verbatim): "Non-chat modes (image/embedding/audio) stay
  excluded from the chat picker (regression guard)."
- S6 (pi #47 S1, verbatim): "`/image <prompt>` → `POST
  {gateway}/v1/images/generations` with the existing authenticated credential
  ..., body `{"model":"sdxl-pixel-art","prompt":"...","n":1,"size":"512x512","output_format":"png"}`."
- S7 (pi #47 S3/S4): flag `--size 512|768|1024` (default 512), timeout
  client-side ≥ 180 s, error amigable ante fallo del gateway sin perder el
  aviso de spend.
- S8 (pi #47 S5, verbatim): "`/image a dragon` produces a rendered
  pixel-art dragon image in the session" → en OpenCode el resultado lleva la
  imagen como file-part cuando el host la pinta, y SIEMPRE el png persistido
  + su ruta (fallback de S2).
- S9 (pi #47 v2 S2): modelos de imagen DESCUBIERTOS del gateway
  (`/v1/models`, mode=image_generation), nunca hardcodeados; selección:
  param explícito > heurística (imagen de entrada → modelo de edición) >
  default `sdxl-pixel-art`.
- S10 (pi #47 v2 S3): edición por instrucción — `image` = "last" (última
  imagen de la sesión) o path png/jpg/webp → multipart
  `POST /v1/images/edits` con el campo `image[]` (fix pi #53).
- S11 (pi #47 v2 S4): timeouts adaptativos (qwen 512=300 s, qwen 1024=600 s,
  resto piso 180 s).
- S12 (pi #56): nombre de tool válido para todos los proveedores:
  `actsis_litellm_generate_image` (sin `:`, charset `[a-zA-Z0-9_.-]`).

## Tasks

- T1 → S3-S4: scope en la caché del catálogo + surface en `status`/`models`
  (`src/catalog-cache.ts`, `src/plugin.ts`, `src/tools.ts`, test nuevo).
- T2 → S5: guard de modos no-chat (suite de catálogo sigue verde).
- T3 → S6-S8: cliente de imágenes (`src/image.ts`), tool
  `actsis_litellm_image`, comando `actsis-litellm-image`, png persistido y
  file-part.
- T4 → S9-S12: tool `generate_image` (`src/image-tool.ts`): discovery,
  política de selección, edits `image[]`, timeouts, store `"last"`.
- T5 → docs: README (secciones de catálogo e imágenes), CHANGELOG, este
  documento.

## Log

- L1 (usuario): "Tenemos una tarea importante, hemos realizado cambios grande
  en pi-actsis-litellm y debemos replicarlos para opencode, revisa el GAP
  actual".
- L2 (decisión, usuario): "Spike file-part y si falla, markdown con el png".
- L3 (revisión del GAP, 2026-10-30): `pi-actsis-litellm` `origin/main`
  `719093a` vs `opencode-actsis-litellm` `origin/main` `986ec77`. Ya en
  paridad: usage-subs v2 (#44), tabla compacta (#45), docs (#46) y todo el
  trabajo de color/budget de 0.6.3. Faltante: issue #48 (scope de catálogo),
  issue #47 (`/image`) y #47 v2 (`generate_image` + fixes). Model-routing
  role profiles NO es gap: en pi se mergeó (#36), se revirtió y el re-merge
  (#40) trajo los reverts — neto cero. Baseline de opencode: 483/483 tests,
  typecheck limpio.
- L4 (restricción de entorno): el host instalado en esta máquina es OpenCode
  `1.18.31`; el plugin apunta a la API v2 (`engines.opencode >= 2.0.0`,
  `@opencode/plugin` 2.0.29). El spike de file-part no se puede ejecutar
  acá: se emiten ambas salidas (file-part + png persistido con su ruta) y la
  verificación en host queda como acceptance pendiente, igual que en pi.

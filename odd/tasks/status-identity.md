# Feature: usuario y team de LiteLLM en el comando status (OpenCode)

Espejo OpenCode de la feature primaria
`../../pi-actsis-litellm/odd/tasks/status-identity.md` (ruta canónica:
`/home/rpinto/Workspace/pi-actsis-litellm/odd/tasks/status-identity.md`).
Las **Specs S1–S8 son las mismas** y no se redefinen aquí: leer el doc primario
completo antes de implementar. Este archivo solo fija las tareas de este repo.

Salida esperada aquí (`actsis_litellm_status`, tool y comando
`actsis-litellm-status`), después de `Auth:` y antes de `Catalog:`:

```
Provider: actsis-litellm
Auth: oauth (expires …)
User: ricardo.pinto@actsis.com (RPINTO, proxy_admin)
Team: Acceso-Completo (ad59169e-f0c9-45a3-aa73-eec187533bdf)
Catalog: N models cached (age …)
Gateway URL: https://ai.actsis.internal
Budget: …
```

## Tasks

| ID | Spec | Route | Commit |
| --- | --- | --- | --- |
| T3 | S3, S4, S5 — `src/identity.ts` + `test/identity.test.ts` | writer (opencode) | `feat(status): fetch gateway user identity and team alias` |
| T4 | S2 — `teamId` de la metadata de la credencial disponible en `status()` | writer (opencode) | `feat(status): expose credential teamId to status` |
| T5 | S1, S2, S6, S7, S8 — cablear en `status()`, tests, docs | writer (opencode) | `feat(status): show connected user and team` |

## Log

- L1 (usuario, verbatim): "Necesitamos arreglar algo importantisimo, nuestro
  comando status no trae el nombre del usuario conectado al gateway, ni en Pi ni
  en Opencode, y ya algunos usuarios me han pedido que ajuste eso, porque no
  saben con que usuario estan conectados ni con que team de LiteLLM habilitaron
  la conexión"
- L2: alcance autorizado = Pi + OpenCode en el mismo trabajo.
- L3: autorizado consultar el gateway real; evidencia en L4 del doc primario.
- L4 (cierre OpenCode, 2026-11-11): T3, T4 y T5 completadas y verificadas.
  T3 y T4 comparten commit (`ad2d128`) porque `extractCredentialTeamId` vive en
  `src/identity.ts`. Evidencia end-to-end contra el gateway real con el módulo
  de este repo: `User: ricardo.pinto@actsis.com (RPINTO, proxy_admin)` y
  `Team: Acceso-Completo (ad59169e-f0c9-45a3-aa73-eec187533bdf)`, con el
  `teamId` extraído de la metadata de la credencial. `npx vitest run`
  514/514, `npx tsc --noEmit` en 0, `package.json`/`package-lock.json`/`dist`
  sin cambios.
- L5 (frontera de slice, 2026-11-11): 1170 líneas autoradas — 766 de tests,
  404 de código y docs — por encima de la guía de ~400 por PR. Estrategia de
  entrega (Git): PR encadenado o dos PRs — **A** = `src/identity.ts` +
  `test/identity.test.ts`, **B** = `src/tools.ts` + `test/tools.test.ts` +
  docs. Push y creación de PR son decisión del usuario.
- L6 (entorno): `npm ci` requirió `--force` por un conflicto de peers
  preexistente (`solid-js ^1.9.17` vs `@opentui/solid`), ajeno a esta feature;
  el manifest no se tocó.

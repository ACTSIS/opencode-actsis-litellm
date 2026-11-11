# Feature: mitigar vulnerabilidades de dependencias (OpenCode)

Espejo OpenCode de la feature primaria:
`/home/rpinto/Workspace/pi-actsis-litellm/odd/tasks/dependency-vulnerabilities.md`
(leer sus Specs S1–S5 completas antes de trabajar; aplican íntegras aquí).
Este archivo fija las tareas de este repo.

## Estado

- T3/T4 hechas: overrides con selector de rango (`undici@>=6 <7` → 6.29.1,
  `undici@>=8` → 8.12.4, `vite` → 8.3.3, `seroval` → ^1.6.11). De 29 alertas
  (2 high) a 0 high / 0 critical / 26 moderate; suite 479/479, `tsc` 0.
- T8 hecha: el stack sube a `@opencode/plugin` 2.2.7 y `@opentui/{core,solid}`
  0.8.4, con overrides nuevos de `glob` 14.0.4, `minimatch` 11.0.8 y
  `google-auth-library` 10.9.1. **`npm audit` queda en 0 vulnerabilidades**
  (antes 29). `solid-js` pasa a `^1.9.12`: el pin exacto `1.9.12` que se usó al
  principio dejaba el árbol inválido (`npm ls` y `npm ci --strict-peer-deps`
  fallaban) y ya no era necesario con el peer `^1.9.12` de `@opentui/solid`
  0.8.4.
- Residual documentado: `@opentui/core@0.8.4` declara `engines.node >=
  26.4.0` (igual que `0.6.5` en `main`: preexistente). npm no lo aplica por
  defecto, pero `npm ci --engine-strict` falla en Node 22. Este repo no tiene
  CI; es el seguimiento pendiente (D2/D5 del verificador independiente).

## Tasks

| ID | Spec | Route | Commit |
| --- | --- | --- | --- |
| T8 | S1, S3, S4 — subir `@opencode/plugin` + `@opentui/core` + `@opentui/solid` (+ `solid-js` al peer que declare) al conjunto más nuevo mutuamente compatible y absorber el fallout | writer | `chore(deps): upgrade the opencode/opentui peer stack` |
| T9 | S2, S4 — registrar lo que quede sin corrección, CHANGELOG y `docs/` | inline | `docs: record dependency vulnerability decisions` |

## Log

- L1 (usuario, verbatim): "Es importantisimo revisar y mitigar todas las
  vulnerabilidades"
- L2: alcance = alertas de Dependabot/`npm audit` de ambos repos.
- L3: `npm ci` ya no requiere `--force` tras alinear `solid-js` en `1.9.12`.
- L4: `@opencode/plugin@2.2.7` exige `@opentui/core >= 0.8.1` como peer; por
  eso el salto debe hacerse junto con `@opentui/*`, no solo con el plugin.
- L5 (cierre OpenCode, 2026-11-11): `npm audit` en **0 vulnerabilidades**
  (antes 29). Stack: `@opencode/plugin` 2.2.7, `@opentui/{core,solid}` 0.8.4,
  `solid-js` 1.9.12; overrides nuevos `glob` 14.0.4, `minimatch` 11.0.8,
  `google-auth-library` 10.9.1. Sin fallout de código: `src/tui.tsx` compila
  sin cambios contra la nueva API. Verificación: `npx vitest run` 479/479,
  `npx tsc --noEmit` 0, `npm run bundle` OK, `npm ci` real sin `--force`.
- L6 (riesgo residual documentado): `glob` 13 → 14 y `minimatch` → 11 son
  overrides fuera del rango declarado por `babel-plugin-module-resolver`
  (`glob ^9.3.3`) y por el pin de `@opencode/util`. La llamada usada es
  `glob()` promesa (compatible 13/14) y toda la verificación local pasa, pero
  el uso de `glob` por el host no está cubierto por los tests de este repo:
  es el punto a vigilar si aparece un fallo de resolución de archivos en
  OpenCode.

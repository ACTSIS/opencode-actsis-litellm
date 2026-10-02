# Changelog

## 0.2.0 — API de plugins de OpenCode v2

### Cambios incompatibles (breaking)

- **Requiere OpenCode >= 2.0.0.** OpenCode v2 eliminó el contrato de plugins
  v1; las implementaciones v1 son descartadas silenciosamente por el loader
  de v2. El plugin ahora exporta por defecto
  `Plugin.define({ id, setup(ctx) })` desde `@opencode/plugin`.
- **Renombramiento de configuración:** la clave `"plugin"` en
  `opencode.json` ahora es `"plugins"`, y el widget de la terminal se
  configura en el archivo global `cli.json` (v2 migra automáticamente
  `tui.json`, pero las entradas de paquetes v1 obsoletas arrastradas a
  `cli.json` bloquean la reconciliación de plugins — elimínalas).
- **El almacenamiento de credenciales se movió al store nativo de
  integraciones de OpenCode.** El login ahora es un flujo de integración
  (método OAuth `sso-browser` + método nativo de API key); OpenCode almacena
  y rota los tokens. El archivo `auth.json` legado de v1 solo se lee como
  fallback para estado previo a v2.

### Agregado

- **Proveedor dinámico OpenAI-compatible para v2** — `ctx.provider.transform`
  registra el proveedor del gateway ligado a su integración vía
  `integrationID`, con el catálogo de modelos en vivo mapeado a `Model.Info`
  de v2 (límites, capacidades, costos escalonados, variants).
- **Cuatro tools** (`actsis_litellm_status`, `actsis_litellm_budget`,
  `actsis_litellm_models`, `actsis_litellm_logout`) registrados vía
  `ctx.tool.transform` con inputs JSON Schema y resultados `{content}`;
  status/budget leen la credencial del store de integraciones de v2 y
  reportan el tipo y la expiración de la auth.
- **Cuatro comandos slash** (`/actsis-litellm-status`, `-models`, `-budget`,
  `-logout`) vía `ctx.command.transform`.
- **Hooks de sesión con scope al proveedor:** `model.request` (header con el
  session-id), `context` (normalización de la opción thinking) y un
  clasificador `http.response` de solo lectura para errores de
  budget/throttle/overflow.
- **Actualización del snapshot de budget** en `session.idle` vía
  `ctx.event.subscribe`.
- **Widget de budget para la TUI** portado a la API v2 de plugins CLI
  (`@opencode/plugin/tui`, slot `sidebar.footer`).

### Corregido

- **Carga desde directorios locales:** el resolver de directorios de
  OpenCode v2 solo prueba `<dir>/index` y `<dir>/tui` e ignora
  `package.json` `main`/`exports`; los shims raíz `index.js` / `tui.js`
  ahora re-exportan los bundles compilados.
- **Rechazos de objetos congelados de Immer:** los callbacks de transform
  son síncronos y la salida de `Model.Info.default()` se copia antes de
  mutarla.
- **Sobrescritura de estado en el flujo de login:** `runLoginFlow` escribía
  el estado del plugin sin un directorio destino, sobrescribiendo el archivo
  de estado real desde tests y logins abortados (con
  `providerId: undefined`). Ahora `LoginConfig.stateDir` se propaga a través
  del flujo, con tests de regresión que fijan el aislamiento del estado.
- **Logout honesto:** el tool de logout revoca el refresh token obtenido de
  la integración y limpia el estado/caché del plugin, y reporta que la
  credencial almacenada debe desconectarse vía la UI de auth nativa de
  OpenCode (no existe una API de plugin para borrarla).

### Notas de migración

- Tras actualizar OpenCode a v2: renombra `"plugin"` a `"plugins"` en
  `opencode.json`, mueve la entrada del widget a `cli.json`, elimina los
  paquetes v1 obsoletos de `cli.json`, reinicia el servidor de OpenCode
  (`pkill -f "opencode serve"`) para que el set de plugins en caché se
  recargue, luego ejecuta `opencode auth login` y selecciona
  `actsis-litellm`.
- Dependencias: `@opencode/plugin` ^2.0.4 (reemplaza `@opencode-ai/plugin`);
  peers `@opentui/*` >= 0.5.10; `engines.opencode >= 2.0.0`.

## Unreleased

### Corregido

- **Las instalaciones por spec de git ya no requieren `npm` ni fallan a
  mitad de instalación** — el script de build se renombra a `bundle`. El
  fetcher de dependencias git de npm (pacote, usado por el instalador
  Arborist de OpenCode) ejecuta un `npm install` completo del clon cuando el
  `package.json` declara un script `build`/`prepare`/`prepack`/`install`,
  incluso con `--ignore-scripts`; sin `npm` en el `PATH` la instalación
  abortaba con `git dep preparation failed`.
- **Instalación más liviana** — `@opentui/core`, `@opentui/solid` y
  `solid-js` son ahora peers opcionales (`peerDependenciesMeta`), así el
  instalador deja de descargarlos (sin los binarios nativos de
  `@opentui`); la TUI de OpenCode provee sus propias copias en runtime.

### Documentación

- **Nueva guía de instalación** (`docs/installation.md`) — referencia
  autorizada de instalación paso a paso: requisitos (OpenCode >= 2.0.0,
  widget verificado en 2.0.20, sin instalación manual de dependencias para
  usuarios finales), instalación recomendada por spec de GitHub en **ambos**
  `opencode.json` (plugin de servidor) y `cli.json` (widget de budget),
  alternativas npm/ruta local con la misma regla de configuración dual,
  walkthrough de login (prompt condicional de URL del gateway, SSO con
  ventana de callback de 5 minutos vs API key), checklist de verificación
  post-instalación, tabla de troubleshooting, y nota de packaging que
  explica por qué `dist/` está commiteado y el contrato de shims raíz para
  el resolver de directorios locales.
- **Nuevo documento de arquitectura** (`docs/architecture.md`) — mapa de
  módulos de `src/` con responsabilidades por módulo, integración con la API
  v2 de OpenCode (transforms de provider/integration/tool/command, hooks de
  sesión `model.request`/`context`/`http.response`, `event.subscribe` para
  `session.idle`), layout de credenciales y archivos, contrato del
  credential reader (`ctx.integration.connection.active` + `resolve`), shape
  del registro del provider, detalles de packaging/loader de la TUI, y el
  ciclo de vida del snapshot de budget.
- **README** — reemplazó la sección de instalación por un inicio rápido de
  configuración dual que enlaza a la guía de instalación, agregó un enlace
  destacado a la guía cerca del inicio, amplió la sección del widget de la
  TUI (bundles `dist/` commiteados, configuración dual, peers para compilar
  desde el código fuente, ciclo de vida del snapshot en `session.idle`) y
  agregó una sección de Arquitectura que enlaza los documentos técnicos.
- **`docs/login-flow.md`** — reescrito para la API v2: el flujo de login
  ahora documenta el método de integración OAuth `sso-browser` (callbacks
  `authorize`/`refresh`) en lugar del hook `auth.loader` con
  `client.auth.set` de v1, y las credenciales se persisten en el store
  nativo de integraciones de OpenCode (`opencode.db`), no en `auth.json`.

### Agregado

- **Precios escalonados de modelos y fallback paginado de model-info** — los
  costos de input/output por encima de 128k/200k/272k/512k tokens de
  contexto que reporta el gateway se mapean a los `cost.tiers` nativos de
  OpenCode (tasas de cache read/write compartidas entre tiers); cuando
  `GET /v1/model/info` falla o no devuelve entradas, el plugin recurre a
  `GET /v2/model/info` con paginación (`size=100`, hasta 5 páginas, fusionadas
  por nombre de modelo). El esquema del caché de modelos se elevó a versión 2
  (los cachés obsoletos se re-sincronizan).
- **Gauge de estado de budget** — `formatBudgetStatus` renderiza el gasto
  como un gauge de 8 celdas (`▰` lleno / `▱` vacío) con porcentaje y
  gasto/límite, usado por los tools status y budget; `budgetGauge` se
  exporta para su reutilización.
- **Tool de diagnóstico `actsis_litellm_budget`** — fuerza una actualización
  del budget y siempre reporta el resultado exacto: la línea de gauge en
  éxito, o el fallo preciso (sin credencial, URL del gateway sin configurar,
  credencial rechazada, error de red/timeout) en lugar de un resultado vacío
  silencioso (-espejo de pi-provider-litellm 0165eae).
- **Refresh de budget post-turno** — el plugin refresca el snapshot de
  budget almacenado en `session.idle` (fin de un turno del agente, paridad
  con pi `agent_end`) y lo persiste con marca de tiempo en el estado del
  plugin; `actsis_litellm_status` y `actsis_litellm_budget` reportan la
  última línea conocida (con antigüedad) cuando un fetch en vivo falla.
- **Comando slash `/actsis-litellm-budget`** — ejecuta el tool
  `actsis_litellm_budget` y resume el resultado desde la barra de prompt
  (espejo del comando `actsis-litellm:budget` de pi-provider-litellm).
- **Widget de budget para la TUI (entrypoint `./tui`)** — plugin opcional de
  slot para la TUI de OpenCode (`src/tui.tsx`, id `actsis-litellm-budget`)
  que renderiza el gauge de budget en el footer de la barra lateral a partir
  del snapshot persistido, actualizado en `session.idle`; se activa listando
  el paquete en el archivo de configuración de la CLI.

### Cambiado

- **Tools y comandos renombrados al namespace actsis-litellm** —
  `litellm_status` -> `actsis_litellm_status`, `litellm_models` ->
  `actsis_litellm_models`, `litellm_logout` -> `actsis_litellm_logout`
  (comandos slash `/actsis-litellm-status`, `/actsis-litellm-models`,
  `/actsis-litellm-logout`); nombre visible del proveedor "ACTSIS LiteLLM" ->
  "Actsis LiteLLM" (espejo de pi-provider-litellm 052c9ca).

- **Status reporta los fallos de budget** — `actsis_litellm_status` ahora
  reporta "Budget unavailable: <reason>" para fallos de gateway/red y una
  línea distinta "Budget: Credential rejected — run /login again" ante un
  rechazo de auth, en lugar de un mensaje genérico de indisponibilidad
  (espejo de pi-provider-litellm 2296166).

### Corregido

- **Entry points del paquete alineados con el loader de la TUI de OpenCode**
  — `main` y `exports["./tui"]` ahora apuntan al `dist/tui.js` compilado (la
  forma que el loader de la TUI resuelve para paquetes npm/git), mientras
  que `exports["./server"]` mantiene el bundle del servidor. Las
  instalaciones públicas solo necesitan el spec del paquete en
  `opencode.json` (servidor) y en el archivo de configuración de la CLI
  (widget).

- **El plugin de la TUI no se cargaba cuando el paquete se consumía desde
  GitHub** — el paquete ahora incluye bundles `dist/` pre-compilados (`main`
  y `exports["./tui"]` apuntan a `dist/*.js`), coincidiendo con la
  resolución de entrypoints que el loader de la TUI de OpenCode realiza para
  paquetes npm/git; las entradas crudas `src/*.tsx` no se resolvían.
- **La API key ya no se solicita dos veces durante `opencode auth login`**
  — para el método de API key, el plugin ahora depende del prompt nativo de
  OpenCode "Enter your API key" y solo declara el prompt de la URL del
  gateway. La clave la almacena OpenCode en su almacén de credenciales y la
  valida el gateway en el primer uso (el plugin ya no la pre-valida contra
  `GET /v1/models` durante el login).

## 0.1.0

Lanzamiento inicial. Plugin de OpenCode que agrega un gateway ACTSIS LiteLLM
como proveedor de modelos dinámico, portado desde la extensión
pi-provider-litellm.

### Agregado

- **Scaffold y metadatos del paquete** — `package.json` (`exports` apuntando
  al código fuente TypeScript para el runtime Bun, `files` limitado a
  `src/README/LICENSE/CHANGELOG`, `engines.opencode >= 1.14.0`),
  `tsconfig.json`, `vitest.config.ts`, `LICENSE` MIT e higiene del
  repositorio (`.gitignore`).
- **Módulo de configuración** (`src/config.ts`, `src/gateway-url.ts`) —
  resolución de la URL del gateway con precedencia
  `env ACTSIS_LITELLM_URL > opciones del plugin > estado almacenado > prompt
  interactivo`, normalización de la URL base (se elimina una `/v1` final) y
  helpers sobre el origen de credenciales almacenadas.
- **Cliente LiteLLM** (`src/client.ts`) — fetch de discovery con validación
  del contrato (`contract_version: 1`, `S256`, mismo origen, adaptación de
  promoción de esquema), registro dinámico de cliente, intercambio de
  tokens, refresh grant con rotación, revocación de tokens, fetches de
  `/v1/models` y `/model/info` y fetch de información de budget — todo con
  guarda de redirects y timeouts por petición.
- **Login OAuth2 PKCE** (`src/pkce.ts`, `src/oauth.ts`) — PKCE S256 +
  `state` aleatorio, servidor callback loopback en `127.0.0.1` (puerto
  efímero, ventana de 5 minutos), flujo SSO authorize que devuelve un
  resultado OAuth compatible con OpenCode, y un método de API key validado
  contra `/v1/models` antes de almacenarse.
- **Estado y caché del catálogo** (`src/state.ts`, `src/catalog-cache.ts`) —
  archivo de estado con versión de esquema y escritura atómica (tmp +
  rename) en `~/.local/share/opencode/actsis-litellm/state.json` y caché de
  modelos en `~/.local/share/opencode/actsis-litellm/models-cache.json`.
- **Descubrimiento y mapeo del catálogo** (`src/catalog.ts`) — `/v1/models` +
  enriquecimiento con `/model/info`, filtro de modo chat (metadata más una
  heurística conservadora por nombre que excluye modelos de
  embedding/whisper/TTS/rerank/audio/moderación) y mapeo a `ModelV2` de
  OpenCode con campos de costo por millón y defaults 128000/16384 de
  contexto/salida.
- **Núcleo del plugin** (`src/plugin.ts`, `src/index.ts`) — hook `config` que
  inyecta el proveedor `@ai-sdk/openai-compatible` con los modelos del
  catálogo y plantillas de comandos `/litellm-*`; hook `auth` con métodos de
  login SSO + API key y un loader que provee `{ apiKey, baseURL, fetch }` con
  inyección Bearer, refresh proactivo persistido vía `client.auth.set` y
  clasificación de errores del gateway; hook `provider.models` para refresh
  del catálogo en vivo; hooks `chat.headers` (`X-Litellm-Session-ID`) y
  `chat.params` (normalización de `thinking`).
- **Tools y auth-store** (`src/tools.ts`, `src/auth-store.ts`) — tools
  `litellm_status`, `litellm_models`, `litellm_logout` (más los comandos
  correspondientes `/litellm-status`, `/litellm-models`, `/litellm-logout`) y
  helpers para leer/limpiar entradas de credenciales en el `auth.json` de
  OpenCode.
- **Budget y normalización de límites/overflow** (`src/budget.ts`,
  `src/limit-errors.ts`, `src/overflow.ts`) — fetch y formateo de
  información de budget (gasto, máximo, hora de reset), clasificación de 429
  en budget-exceeded vs throttling con mensajes accionables, y prefijo
  `context_length_exceeded` para que la compactación de OpenCode pueda
  reaccionar.
- **Documentación** — `README.md` seguro para uso público (instalación,
  login, precedencia de configuración, métodos de auth, catálogo,
  tools/comandos, hardening de errores, troubleshooting, notas de seguridad)
  y `docs/login-flow.md` con la secuencia completa de OAuth2 PKCE.
- **Tests** — 13 archivos vitest, 160 tests que cubren resolución de
  configuración, validación del contrato del cliente, flujo PKCE/login,
  estado y caché, mapeo y filtrado del catálogo, hooks del plugin, tools,
  auth-store, budget y clasificación de límites/overflow (`fetch`
  mockeado; sin red en los tests).

### Notas

- Distribución segura para uso público: solo placeholders
  `https://your-gateway.example.com`; sin hosts internos, IPs, tokens ni
  usernames en los archivos commiteados.
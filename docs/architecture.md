# Arquitectura

Vista técnica del plugin `opencode-actsis-litellm`: mapa de módulos de
`src/`, contrato del plugin de servidor, composición de la TUI, puntos de
integración con OpenCode v2, credenciales y archivos, shape del proveedor, y
ciclo de vida del snapshot de budget.

Para instalación y login consulta
[installation.md](installation.md) y
[login-flow.md](login-flow.md).

## Mapa de módulos (`src/`)

Cada módulo tiene una única responsabilidad; `index.ts` y `tui.tsx` son los
dos puntos de entrada (plugin de servidor y plugin de la TUI,
respectivamente).

| Módulo | Responsabilidad |
|--------|-----------------|
| `config.ts` | Normalización y resolución de opciones del plugin; normalización de la URL base (elimina una `/v1` final); constantes por defecto (TTL 15 min, timeout 30 s). |
| `gateway-url.ts` | Resolución de precedencia de la URL del gateway (env `ACTSIS_LITELLM_URL` > opciones del plugin > estado almacenado > prompt) y helpers sobre el origen de las credenciales almacenadas. |
| `client.ts` | Cliente del gateway LiteLLM CLI-auth: fetch de discovery con validación del contrato (`contract_version: 1`, `S256`), registro dinámico de cliente, intercambio de código de autorización, refresh grant con rotación, revocación de tokens, y fetches de `/v1/models` + `/v1/model/info` + paginado `/v2/model/info` — todo con timeouts por petición. |
| `gateway-client.ts` | Token de acceso fresco para lecturas del gateway desde tools/refresh (`ensureFreshToken`, ventana proactiva de 5 minutos) y reconstrucción del discovery desde el estado (`discoveryFromState`). |
| `pkce.ts` | Generación del verifier/challenge PKCE S256 y del parámetro `state` aleatorio. |
| `oauth.ts` | Orquestación del login SSO: servidor callback loopback (`127.0.0.1`, puerto efímero, ventana de 5 minutos), parseo/validación de parámetros del callback, y flujo completo de autorización (`runLoginFlow`) que recibe `stateDir` en su `LoginConfig` (evita sobrescribir el estado real desde tests o logins abortados). |
| `state.ts` | Archivo de estado del plugin con versión de esquema (`~/.local/share/opencode/actsis-litellm/state.json`), escrituras atómicas (tmp + rename); almacena metadatos no secretos del gateway, el último snapshot de budget y `budgetRefreshedAt`. |
| `catalog-cache.ts` | Persistencia del caché de modelos (esquema v2) en `~/.local/share/opencode/actsis-litellm/models-cache.json` con escrituras atómicas, cálculo de antigüedad del caché y re-sincronización de cachés obsoletos. |
| `catalog.ts` | Descubrimiento y mapeo del catálogo: `/v1/models` enriquecido con `/v1/model/info` (fallback paginado a `/v2/model/info`, hasta 5 páginas de 100), filtro de modo chat, y mapeo a `Model.Info` de v2 (costos por millón, cost tiers sobre 128k/200k/272k/512k, defaults 128000/16384 de contexto/salida). |
| `plugin.ts` | Núcleo del plugin de servidor v2: `Plugin.define` con el `setup(ctx)` que registra el integration (métodos de auth), el provider, los tools, los comandos, los hooks de sesión y el loop de eventos; construye el `credential reader` v2 (`ctx.integration.connection.active` + `resolve`); y coordina la composición de los demás módulos. |
| `tools.ts` | Los cuatro tools de diagnóstico (`actsis_litellm_status`, `actsis_litellm_models`, `actsis_litellm_logout`, `actsis_litellm_budget`) con forma v2 `Tool.Info` (`input` JSON Schema + `execute` asíncrono → `{content}`), leen la credencial del reader v2 y limpiar/leer entradas del archivo `auth.json` v1 como fallback. |
| `auth-store.ts` | Helpers de lectura/clear sobre las entradas de credenciales del archivo `auth.json` de OpenCode (fallback legado v1). |
| `budget.ts` | Fetch y formateo del budget: gasto/límite/reset, porcentaje de uso, gauge de 8 celdas `▰`/`▱` (`budgetGauge`) y la línea de estado (`formatBudgetStatus`). |
| `budget-widget.ts` | Lado widget: lee el snapshot persistido del archivo de estado del plugin y calcula la línea a mostrar (devuelve `null` cuando no hay nada confiable que mostrar). |
| `limit-errors.ts` | Normalización de errores del gateway: parseo de errores estructurados de límites, clasificación de respuestas 429 en budget-exceeded vs throttling, y formateo de mensajes accionables con horas de reset. |
| `overflow.ts` | Detección de mensajes de error de overflow de la ventana de contexto (para la clasificación informativa del hook `http.response`). |
| `errors.ts` | Errores de dominio (`ConfigError`, `AuthError`) usados por toda la librería. |
| `tui.tsx` | Entrada del plugin CLI de la TUI (`@opencode/plugin/tui`, JSX de `@opentui/solid`): registra el slot `sidebar.footer` con el gauge de budget, actualizado al arrancar y en `session.idle` con un debounce de 2 segundos. |
| `index.ts` | Entrada del plugin de servidor: re-exporta `Plugin.define` (default), `DEFAULT_PROVIDER_ID` y utilidades. |

### Composición

- **Lado servidor:** `index.ts` re-exporta `plugin.ts`. El `setup(ctx)` de
  `plugin.ts` compone `config.ts`/`gateway-url.ts` (resolución de URL),
  `client.ts` + `oauth.ts` + `pkce.ts` (login), `catalog.ts` +
  `catalog-cache.ts` (modelos), `tools.ts` (diagnóstico),
  `limit-errors.ts` + `overflow.ts` (hardening de errores), `auth-store.ts`
  (fallback credenciales v1), `gateway-client.ts` (tokens frescos) y
  `budget.ts` + `state.ts` (persistencia del snapshot en `session.idle`).
- **Lado TUI:** `tui.tsx` es una entrada separada que comparte únicamente
  `budget-widget.ts` (lectura del snapshot y formateo de línea) y el archivo
  de estado con el plugin de servidor. Nunca hace llamadas de red.

## Integración con OpenCode v2

### Registro vía transforms y hooks

Todos los registros y hooks se aplican en el `setup(ctx)` de `plugin.ts`:
el plugin es un `Plugin.define({ id, setup(ctx) })` de `@opencode/plugin`.

| API v2 | Uso |
|--------|-----|
| `ctx.integration.transform` | Registra los **métodos de autenticación** de la integración vía `editor.method.update(...)`: el método OAuth `sso-browser` (con callbacks `authorize` y `refresh`) y el método nativo `key` de OpenCode. |
| `ctx.provider.transform` | Registra el proveedor con `editor.add({ info: Provider.Info, models })`. El proveedor está ligado a la integración vía `integrationID`; la lista de modelos es el catálogo inicial construido antes del registro (invariante Immer, ver más abajo). |
| `ctx.tool.transform` | Registra los cuatro tools con `editor.add({ name, description, input: JSONSchema, execute })`. |
| `ctx.command.transform` | Registra los cuatro comandos slash con `editor.add({ name, description, execute })`. Cada `execute({ sessionID, ... })` envía un prompt vía `ctx.session.prompt` con una plantilla que menciona el tool correspondiente. |
| `ctx.session.hook(..., { providerID })` | Hooks de sesión con scope al proveedor del plugin: `model.request` (header `X-Litellm-Session-ID` con el `sessionID`), `context` (normaliza la opción `thinking` a `{ type: "disabled" \| "adaptive" }`) y `http.response` (clasificación informativa de errores de límite; no reescribe la respuesta). |
| `ctx.event.subscribe({ signal })` | Loop async que escucha el evento `session.idle` y dispara la actualización del snapshot de budget (persistido en `state.json`); limpiado con `AbortController`. |

### Composición server/TUI

El plugin de servidor (`dist/index.js`) y el plugin de la TUI
(`dist/tui.js`) son dos entradas totalmente independientes:

- la variante server vive en el proceso del servidor de OpenCode (plugin
  de `opencode.json`);
- la variante CLI/TUI vive en el proceso de la interfaz TUI (plugin de
  `cli.json`), registrada con `Plugin.define({ id: "actsis-litellm-budget",
  setup(context) })` de `@opencode/plugin/tui` y renderizando con
  `context.ui.slot({ append: "sidebar.footer", render })` — nota que el slot
  es `sidebar.footer`, no `sidebar_footer`;
- ambos se sincronizan solo por el archivo de estado compartido, en el
  evento `session.idle` (el server escribe, la TUI lee con debounce de 2 s).

### Credenciales y layout de archivos

| Store | Ubicación | Contenido |
|-------|-----------|-----------|
| Store nativo de integraciones de OpenCode | SQLite `~/.local/share/opencode/opencode.db` (tabla `credential`) | Credenciales OAuth (access/refresh/expires, `methodID`, metadata con `userId`/`teamId`) o API keys. Escritas y gestionadas por OpenCode v2; el plugin nunca escribe tokens aquí. |
| Fallback legado v1 | `~/.local/share/opencode/auth.json` | Entradas de credenciales de instalaciones previas a v2. Solo lectura y limpieza (logout), nunca se usa en v2 como fuente primaria. |
| Archivo de estado del plugin | `~/.local/share/opencode/actsis-litellm/state.json` | Metadatos no secretos del gateway (URL, snapshot de discovery, client ID, endpoints, `resource`, `schemeUpgraded`, modo de auth) más el snapshot de budget (`lastBudgetSnapshot`) y `budgetRefreshedAt`. |
| Caché de modelos | `~/.local/share/opencode/actsis-litellm/models-cache.json` | Catálogo de modelos cacheado, esquema **v2** (los cachés obsoletos se re-sincronizan automáticamente). |

### Contrato del credential reader

Cada tool y el flujo de budget obtienen la credencial activa vía el reader
construido en `plugin.ts` (`makeCredentialReader`):

1. `ctx.integration.connection.active(providerId)` devuelve la conexión
   activa para la integración.
2. `ctx.integration.connection.resolve(conn)` devuelve el
   `Credential.Value` de v2 (`{type:"oauth", ...}` o `{type:"key", ...}`).
3. Si no hay conexión activa o no hay credencial resoluble, el reader
   devuelve `null` y el fallback al archivo v1 `auth.json` aplica aguas
   abajo (lectura/clear por el `auth-store.ts`).

Los tools no refrescan ni persisten tokens por sí mismos: llaman a
`ensureFreshToken` para obtener un access token vigente para sus lecturas
del gateway, y OpenCode es quien persiste las credenciales rotadas vía el
callback `refresh` del método de integración.

### Shape del registro del provider

El `ctx.provider.transform` registra un `Provider.Info` construido por
`buildProviderInfo(closure)`, que parte del `Provider.Info.empty` de v2:

- `name`: "Actsis LiteLLM"
- `activation: "enabled"` — siempre activo
- `package`: `@opencode/ai/providers/openai-compatible`
- `settings.baseURL`: la URL base del gateway con `/v1` agregada
- `integrationID`: el `providerId` — así las credenciales de la integración
  alimentan el bearer token / API key

Los modelos se construyen con `buildInitialModels(closure)` antes de registrar
el provider: si hay credencial y URL, fetch del catálogo con fallback a
caché; si no, catálogo cacheado.

### Invariantes

- **Transforms síncronos:** los callbacks de `ctx.provider.transform` (y de
  los demás edits) deben ser **síncronos** — el registro usa Immer y los
  updates asíncronos dentro de la edición rompen el contrato. Por eso el
  catálogo se carga ANTES (`buildInitialModels`) y se captura en el closure.
- **Objetos congelados:** `Model.Info.default()` devuelve un objeto frozen;
  se copia antes de mutarlo para no violar la invariante de Immer.

## Packaging / contrato del loader de la TUI

OpenCode instala los paquetes de npm/git con `--ignore-scripts`, por lo que
los bundles compilados de `dist/` están **commiteados en el repositorio**;
un build de `prepack` nunca corre en la máquina del usuario. Tras cambiar
`src/`, ejecuta `npm run bundle` y commitea los `dist/` regenerados. No
renombres el script a `build` (ni `prepare`/`prepack`/`install`): el fetcher
de git de npm correría un `npm install` completo del clon y fallaría en
máquinas sin `npm` en el `PATH`.

El resolver de OpenCode v2 se comporta distinto para paquetes vs directorios
locales:

- **Paquetes npm/git:** el loader resuelve vía `main` y `exports` del
  `package.json` (`"."` → `dist/index.js` para el plugin de servidor,
  `"./tui"` → `dist/tui.js` para el widget).
- **Directorios locales:** el resolver únicamente prueba `<dir>/index` y
  `<dir>/tui` en la raíz del paquete e ignora `package.json`
  `main`/`exports`. Por eso el repositorio incluye los shims raíz
  `index.js` y `tui.js` que re-exportan los bundles compilados.

Las entradas crudas `src/*.tsx` se omiten silenciosamente por el loader.

El transform universal (`esbuild-plugin-solid`, `{ moduleName:
"@opentui/solid", generate: "universal" }`) compila el JSX de Solid para
targets server y TUI, por lo que un único bundle commiteado sirve ambos
entrypoints. Los peers `@opentui/core`, `@opentui/solid` y `solid-js` solo
son necesarios para compilar desde el código fuente (devDependencies).

## Ciclo de vida del snapshot de budget

1. **Escritura (plugin de servidor).** En `session.idle` (fin de un turno
   del agente) el loop de `ctx.event.subscribe` refresca el budget desde el
   gateway y guarda el snapshot (`lastBudgetSnapshot` + `budgetRefreshedAt`)
   en el archivo de estado del plugin. Los fallos son silenciosos — los
   tools pueden forzar un fetch fresco.
2. **Lectura (tools).** `actsis_litellm_status` y `actsis_litellm_budget`
   reportan el valor en vivo cuando el gateway es alcanzable; cuando el
   fetch en vivo falla, caen al último snapshot cacheado y reportan el
   motivo preciso del fallo (sin credencial, URL del gateway sin configurar,
   credencial rechazada, error de red/timeout).
3. **Lectura (widget de la TUI).** `tui.tsx` (id `actsis-litellm-budget`)
   lee el snapshot del archivo de estado al arrancar y lo relee en
   `session.idle` (con un debounce de 2 segundos para que la escritura del
   lado servidor gane la carrera), renderizando la línea del gauge en el
   slot `sidebar.footer`. No renderiza nada cuando no hay datos.
# Changelog

## Sin publicar — 2026-10-30 — paridad pi #48 y #47 (catálogo e imágenes)

- Añadido: **scope de la credencial/equipo en el caché del catálogo** — la
  caché guarda qué credencial la generó (login OAuth con `userId`/`teamId`, o
  API key) como campo aditivo del esquema v2 (los cachés viejos se leen
  igual); `/actsis-litellm-status` y `/actsis-litellm-models` lo muestran
  (`Catalog scope: …`) y el tool de catálogo sugiere re-login cuando hay team y
  el catálogo es solo `oc/*`. Causa raíz: el gateway recorta `/v1/models` por
  el equipo elegido en el consent del login; no había nada que filtrar en el
  plugin. Espejo de pi-actsis-litellm#48 (PR #49).
- Añadido: **`/actsis-litellm-image` + tool `actsis_litellm_image`** —
  generación de imágenes con `POST /v1/images/generations` (modelo
  `sdxl-pixel-art`, `n=1`, png), flag `--size 512|768|1024` (default 512),
  timeout de cliente de al menos 180 s y errores amigables sin perder el aviso
  de spend; usa la misma credencial que el chat. El png se persiste siempre y
  el resultado trae la imagen como adjunto (file-part) más su ruta como
  fallback. Espejo de pi-actsis-litellm#47 (PR #49).
- Añadido: **tool `actsis_litellm_generate_image`** — pedir imágenes
  naturalmente en el chat: descubre los modelos de imagen del gateway
  (`/v1/models`, modo `image_generation`) para la descripción y la selección
  (param explícito > imagen de entrada → modelo de edición > default), edita
  por instrucción con multipart `image[]` usando `image: "last"` o una ruta, y
  usa timeouts adaptativos (Qwen 1024 = 600 s, Qwen 512/768 = 300 s, resto
  180 s). Nombres de tool en el charset seguro de proveedores (sin `:`).
  Espejo de pi-actsis-litellm#50/#52/#54/#56 (PRs #51/#53/#55).
- Guard de regresión: los modelos con modo `image_generation` siguen excluidos
  del selector de chat.
- Docs: README (scope del catálogo, generación de imágenes) y mapa de módulos
  de `docs/architecture.md`.

## Sin publicar — 2026-10-22 — usage-subs: contrato v2 y tabla compacta

- Añadido: **`/subs-usage` como ruta canónica** con fallback a
  `/ollama-usage` en 404, para seguir funcionando contra gateways anteriores
  al rename.
- Añadido: `SubscriptionUsage` acepta `provider`/`account`/`status` del
  contrato v2; la columna `Sub` muestra `provider:account` (`chatgpt:0`,
  `claude:0`) y queda verbatim en payloads legacy.
- Cambiado: **tabla compacta** — sin contadores de requests/tokens ni sufijo de
  plan; ancho máximo ~94 columnas contra el gateway productivo (antes ~130).
- Cambiado: una ventana intacta sin reloj de reset muestra `full` en lugar de
  `-` (Anthropic devuelve `five_hour.resets_at = null` mientras la ventana de
  5 h no se usa).

## 0.6.3 — 2026-10-16 — Emparejada con pi-actsis-litellm

- Añadido: **colores por umbral en las líneas de budget de los tools** — la
  paleta truecolor quedó compartida en `src/gauge-color.ts` (antes duplicada),
  `formatBudgetLine` y `formatBudgetStatus` aceptan `{color: true}` y el
  `actsis_litellm_budget`, las líneas por-key y el snapshot vivo de
  `actsis_litellm_status` la usan (verde ≤50 %, amarillo 51–75 %, naranja
  76–90 %, rojo >90 %). Sin cap queda neutro; errores y fallbacks "last known"
  siguen en texto plano; los sufijos TPM/RPM/resets van fuera del run
  coloreado. La salida sin color es byte-idéntica. Espejo de
  pi-actsis-litellm#35 (PRs #37/#38); issue #21, PR #22.
- Corregido: **color en el chat (segunda pasada)** — verificado contra la base
  de mensajes de opencode: el almacenamiento elimina el byte ESC del texto del
  assistant, así que el renderer `ansi` recibía códigos literales sin escapes y
  no pintaba nada. `src/ansi.ts` ahora reconoce ambas formas (ESC completo y
  fragmentos ESC-less `\[[0-9;:]*[A-Za-z]`, 19 tests; los corchetes que no son
  fragmentos SGR quedan literales).
- Corregido: **color en el widget de la TUI** — el reconciler de `@opentui/solid`
  solo aplica el prop `style` en nodos de texto (un prop `fg` suelto se ignora),
  así que el widget Budget ahora compone la línea con
  `<span style={{ fg }}>` por segmento (`src/tui.tsx` + `budgetWidgetSegments`).
- Corregido: **color en el chat** — los fences con info string `ansi` se
  renderizan con un code-block renderer registrado desde el plugin TUI
  (`context.markdown.registerCodeBlockRenderer`, el mismo mecanismo builtin de
  opencode para latex/mermaid): el nuevo parser `src/ansi.ts` convierte el SGR
  truecolor (38;2;r;g;b, resets 0/39; secuencias no-SGR y OSC stripped) en runs
  coloreados. Los templates de comandos y las descripciones de tools exigen el
  fence ```ansi. La salida de los tools no cambia.

## 0.6.2 — 2026-10-15 — Emparejada con pi-actsis-litellm

- Corregido: **ritmo de ventana en `usage_subs`** — el collector en vivo envía
  `from`/`until` con `until ≈ hora de generación` (rango de medición cerrado);
  con la precedencia original eso computaba ~100% de ventana transcurrida y
  deshabilitaba en silencio el escalado de color y la proyección. Ahora el
  instante de reinicio (`resetsAt`, contra la longitud fija 5h/semanal) decide
  el transcurrido, y los límites `from`/`until` del collector solo se usan
  cuando no hay reinicio y la ventana sigue abierta (`until > ahora`); rangos
  cerrados no aportan ritmo. Reporte vivo: 5h con 57% usado y reinicio a
  `3 h 26 min` (~31% transcurrido, ritmo 1.82) se mostraba amarillo sin
  proyección; con la corrección queda naranja con `→ 182%`. Cierra #17,
  espejo del fix de pi-actsis-litellm (issue #31, PR #32).

## 0.6.1 — 2026-10-15 — Emparejada con pi-actsis-litellm

- **Ritmo de ventana en `usage_subs`** — el indicador coloreado de las ventanas
  ya no se decide solo por el porcentaje usado: cuando el consumo va adelantado
  respecto a la ventana (ritmo = % usado / % transcurrido > 1, con piso de 10%
  transcurrido), el color escala un nivel de umbral y la celda agrega la
  proyección lineal al fin de la ventana (`15% → 150%`, techo de 200%). Sin
  límites de ventana conocidos (`from`/`until` o instante de reinicio) se
  conserva el color por umbral absoluto y no se muestra proyección. Espeja la
  funcionalidad emparejada de `pi-actsis-litellm`.

## 0.6.0 — 2026-10-15 — Emparejada con pi-actsis-litellm

Esta versión conserva la paridad funcional y de empaquetado con la extensión
hermana `pi-actsis-litellm`. Como la etiqueta `v0.5.0` quedó marcada sin
release publicado, las notas públicas de esta versión consolidan el trabajo
introducido desde la última release publicada (`v0.4.0`).

### Agregado

- **Reinicios de suscripción como tiempo restante** — la ventana de 5 horas
  muestra horas/minutos (`2 h 35 min`) y la ventana semanal, días/horas
  (`3 d 8 h`), en lugar de fechas absolutas de reinicio. Los tiempos se redondean
  hacia arriba a la unidad mostrada; los reinicios vencidos muestran cero y las
  fechas ausentes o inválidas muestran `-`.
- **Fechas absolutas en la zona del sistema** — generación de reportes de
  suscripción, vencimiento de credenciales, reinicio del presupuesto y reinicio
  por límites se muestran con fecha local, reloj de 24 horas, identificador de
  zona y desplazamiento UTC (`2026-10-14 09:56 (America/Bogota, GMT-05:00)`),
  incluyendo cambios de horario de verano. No se requiere configurar zona.
- **Rangos UTC explícitos** — `/actsis-litellm-usage`, `actsis_litellm_usage` y
  el widget Top models conservan sus cálculos y totales por rangos de fechas UTC,
  ahora identificados como días UTC. Las duraciones y la antigüedad de caché no
  dependen de la zona horaria.
- **Paquete publicado actualizado** — el bundle `dist/` incluye el comando y las
  herramientas de suscripción junto con la presentación de fechas y reinicios.

## 0.5.0 — 2026-10-14 — Emparejada con pi-actsis-litellm

- **Tool `actsis_litellm_usage_subs` + comando `/actsis-litellm-usage-subs`** —
  consumo de Ollama Cloud por suscripción como el panel del proveedor:
  porcentaje restante de la ventana de 5 horas y semanal con reinicios y
  créditos, agregados por el collector del gateway.
- Render tabular con indicadores coloreados por umbral
  (verde/amarillo/naranja/rojo) y padding medido en longitud visible.
- Auditoría de dependencias: 0 vulnerabilidades (@opencode/plugin 2.0.29,
  @opentui 0.6.5, solid-js 1.9.17, overrides seroval/esbuild).

## 0.4.0 — 2026-10-13 — Primera versión compartida con pi-actsis-litellm

Números de release emparejados con la extensión hermana `pi-actsis-litellm`
(que salta de su 0.1.0 sin publicar a 0.4.0 con todo el ciclo de paridad);
de aquí en adelante ambos suben en tandom.

### Corregido

- **El widget de Budget quedaba congelado en un valor viejo** mientras los
  comandos mostraban el valor fresco: OpenCode v2 ya no emite el evento
  `session.idle` (deprecado en el schema v2; su ciclo de vida real usa
  `session.execution.succeeded/failed/interrupted`), y los disparadores de
  refresco del widget (loop del plugin y hook del TUI) filtraban exactamente
  por `session.idle` — nunca disparaban. El snapshot persistido en
  `state.json` era correcto todo el tiempo; el widget solo re-leía al
  arrancar. Ahora los dos lados se disparan con los eventos de ejecución
  (manteniendo `session.idle` por compatibilidad) y el TUI añade un poll de
  seguridad cada 60 s sobre el estado persistido.

## 0.3.0 — 2026-10-09 — Paridad con pi-actsis-litellm (uso, Top-5, TLS, OAuth)

### Agregado

- **Capa de datos de uso con paridad de dashboard** — la consulta primaria usa
  `GET /user/daily/activity/aggregated` con un filtro `user_id` tomado de la
  credencial almacenada (totales estables en una sola llamada, delimitados al
  usuario propio; un token admin sin el filtro vería el gasto org-wide).
  Fallback de paginación completa del endpoint clásico
  `GET /user/daily/activity`, adoptando los metadatos por página solo cuando
  hay una página.
- **Aliasing público para las filas de gasto** — los nombres internos de
  despliegue de LiteLLM (`openai/...`) se mapean a los aliases públicos del
  catálogo (`oc/...`) por id exacto o por sufijo compartido tras la última
  `/` (primero ordenado en caso de ambigüedad), fusionando las filas del
  mismo modelo público en tiempo de presentación.
- **Comando `/actsis-litellm-usage` + tool `actsis_litellm_usage`** — gasto,
  tokens y peticiones por modelo: sin argumentos (últimos 30 días
  inclusivos), un número de días (`14`, mínimo 1) o un rango explícito
  inclusivo `YYYY-MM-DD .. YYYY-MM-DD`. Tabla alineada Modelo / Gasto /
  Tokens / Reqs con tokens compactos (k/M) y fila Total, más una nota de
  actividad del gateway (`GET /gateway/daily/activity`, la fuente del
  *Total Requests* del dashboard, con tráfico no registrado).
- **Filas Top-5 en el widget de la TUI + gauge de participación** — bajo la
  línea de budget se renderizan los 5 primeros modelos por gasto de los
  últimos 7 días (título `Top models (7d) · $<total>`, separador `=`, gasto y
  porcentaje alineados a la derecha, gauge de 8 celdas por fila). Filas
  persistidas en el `state.json` del plugin, refrescadas en `session.idle`
  (mismos disparadores que el budget) con TTL de 5 minutos; relleno de
  columnas con espacios no separables (NBSP) para que la alineación
  sobreviva a los sanitizadores de terminal.
- **Preferencia persistente del widget Top-5** — `/actsis-litellm-top` y el
  tool `actsis_litellm_top` aceptan `on`, `off` o `toggle` (sin argumentos
  alterna); la elección persiste en el archivo propio del plugin
  `~/.local/share/opencode/actsis-litellm/preferences.json` (clave
  `"topModelsWidget"`, activado por defecto, escritura atómica). `off` limpia
  las filas de inmediato y deja de consultar el gateway; `on` refresca al
  momento.
- **Bootstrap TLS de CAs del sistema** — al arrancar el plugin carga las CAs
  del sistema operativo por encima del set embebido de Node (comportamiento
  de `--use-system-ca`, APIs de Node >= 22.19.0 con no-op seguro), de modo
  que gateways firmados por una CA privada interna funcionen sin
  configuración por máquina. Estrictamente aditivo, una vez por sesión,
  fail-open y con opt-out vía `ACTSIS_LITELLM_NO_SYSTEM_CA=1`. Los errores de
  confianza TLS llevan la remediación concreta por plataforma
  (`NODE_USE_SYSTEM_CA`, `certutil -encode` → `NODE_EXTRA_CA_CERTS`,
  `--use-openssl-ca` / `SSL_CERT_FILE`).

### Cambiado

- **Etiqueta visible del inicio de sesión renombrada a "OAuth (browser)"** —
  el gateway usa OAuth2 PKCE, no SSO; el id del método (`sso-browser`) y los
  identificadores de la credencial almacenada no cambian (compatibilidad con
  credenciales ya guardadas). README/CHANGELOG actualizados.

### Corregido

- **Causa raíz de los errores de red** — los fallos de transporte ya no se
  reportan como el opaco `TypeError: fetch failed`: el mensaje recorre la
  cadena de `cause` y nombra el motivo real (`ENOTFOUND`, `ECONNREFUSED`,
  códigos de confianza TLS, `ETIMEDOUT`, `ECONNRESET`) con una sugerencia
  accionable para las clases conocidas. Aplica a discovery, registro de
  cliente, intercambio/refresh/revocación de tokens, catálogo, budget y uso
  (`AuthError` ahora envuelve los `TypeError` crudos de esos flujos y las
  fallas de red nunca se confunden con una credencial rechazada).

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
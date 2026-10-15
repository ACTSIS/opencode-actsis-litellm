# opencode-actsis-litellm

Plugin de [OpenCode](https://opencode.ai) que agrega un gateway **Actsis
LiteLLM** como proveedor de modelos dinámico, con inicio de sesión OAuth2 PKCE
(vía OAuth (browser)), autenticación opcional por API key y un catálogo de
modelos dinámico.

El plugin se integra al flujo nativo `/login` de OpenCode v2, descubre el
catálogo de modelos del gateway en tiempo de ejecución y enruta las
peticiones de chat por el endpoint OpenAI-compatible
`/v1/chat/completions`.

> **¿Vas a instalarlo?** Comienza con la guía paso a paso:
> **[docs/installation.md](docs/installation.md)** — requisitos, configuración
> dual, walkthrough de login, checklist de verificación y troubleshooting.

Verificado en OpenCode **v2.0.20** con un gateway real (OAuth activo,
catálogo sincronizado y budget operativo).

## Inicio rápido

Agrega el spec de GitHub a **ambos** archivos de configuración de OpenCode
(el plugin de servidor y el widget de budget de la TUI se registran por
separado):

```json
// ~/.config/opencode/opencode.json (plugin de servidor)
{
  "plugins": ["github:ACTSIS/opencode-actsis-litellm"]
}

// ~/.config/opencode/cli.json (widget de budget)
{
  "plugins": ["github:ACTSIS/opencode-actsis-litellm"]
}
```

Luego ejecuta `opencode auth login`, selecciona `actsis-litellm` y sigue los
pasos. Consulta **[docs/installation.md](docs/installation.md)** para el
walkthrough completo, los métodos alternativos de instalación (paquete npm,
ruta local) y el checklist de verificación post-instalación.

## Login

Inicia OpenCode y ejecuta:

```
opencode auth login
```

1. Selecciona el proveedor `actsis-litellm`.
2. El prompt de **URL del gateway** aparece cuando la URL no está ya
   configurada (ver [Configuración](#configuración) para definirla con
   antelación). Así el plugin funciona sin configuración previa: a los
   usuarios nuevos simplemente se les pregunta.
3. Elige el método de inicio de sesión:
   - **OAuth (browser)** — flujo OAuth2 Authorization Code con PKCE (S256). Se
     abre tu navegador, inicias sesión a través de tu proveedor de identidad
     y el gateway redirige a un callback local loopback.
   - **API key** — el propio OpenCode solicita la clave ("Enter your API
     key") y la guarda en su almacén de credenciales. El plugin solo pide la
     URL del gateway cuando no está configurada; la clave la valida el
     gateway en el primer uso (el plugin no la pre-valida durante el login).

Las credenciales las persiste OpenCode en su almacén nativo de integraciones
(SQLite, no en un archivo JSON); el plugin guarda en su archivo de estado
únicamente metadatos no secretos del gateway (ver
[Notas de seguridad](#notas-de-seguridad)).

## Configuración

Funciona sin configuración por defecto. La URL base del gateway se resuelve
con la siguiente precedencia (de mayor a menor):

| Prioridad | Fuente | Ejemplo |
|-----------|--------|---------|
| 1 | Variable de entorno | `export ACTSIS_LITELLM_URL=https://your-gateway.example.com` |
| 2 | Opciones del plugin (forma objeto en `opencode.json`) | `{ "package": "opencode-actsis-litellm", "options": { "url": "https://your-gateway.example.com" } }` |
| 3 | Estado del plugin almacenado (escrito por un login anterior) | `~/.local/share/opencode/actsis-litellm/state.json` |
| 4 | Prompt interactivo durante `opencode auth login` | Prompt de URL del gateway con validación |

Las opciones del plugin usan la forma objeto `{ package, options }` de la
clave de configuración `plugins` (array):

```json
{
  "plugins": [
    {
      "package": "github:ACTSIS/opencode-actsis-litellm",
      "options": {
        "url": "https://your-gateway.example.com",
        "providerId": "actsis-litellm",
        "catalogTtlMinutes": 15,
        "requestTimeoutMs": 30000
      }
    }
  ]
}
```

| Opción | Tipo | Valor por defecto | Descripción |
|--------|------|-------------------|-------------|
| `url` | string | — | URL base del gateway. Una `/v1` final se elimina automáticamente. |
| `providerId` | string | `actsis-litellm` | ID del proveedor registrado en OpenCode. |
| `catalogTtlMinutes` | number | `15` | Tiempo de vida (TTL) del caché del catálogo de modelos, en minutos. |
| `requestTimeoutMs` | number | `30000` | Timeout por petición HTTP hacia el gateway, en milisegundos. |

## Métodos de autenticación

| Método | Cómo funciona |
|--------|---------------|
| **OAuth (browser)** | OAuth2 Authorization Code + PKCE (S256). El plugin obtiene los metadatos de discovery en `/.well-known/litellm-cli-auth`, registra el cliente de forma dinámica, abre el navegador y captura la redirección en un servidor callback exclusivamente loopback (`127.0.0.1`, puerto efímero). La ventana del callback es de **5 minutos**. OpenCode almacena los tokens de acceso y refresh y los rota en cada renovación. |
| **API key** | OpenCode pide la clave de forma nativa ("Enter your API key") y la guarda en su almacén de credenciales. El plugin solo declara el prompt de la URL del gateway (preguntado cuando no está configurada). La clave la valida el gateway en el primer uso. Las credenciales de API key nunca expiran y nunca se renuevan. |

## Catálogo de modelos

La lista de modelos del proveedor se sincroniza desde el gateway por
`/v1/models` y se enriquece con los detalles de `/v1/model/info` cuando está
disponible.

- **Filtro de modo chat** — Se excluyen los modelos que no son de chat
  (embedding, whisper, TTS, rerank, transcripción, moderación, audio y
  similares), usando los metadatos de modo por modelo cuando el gateway los
  reporta y una heurística conservadora por nombre en caso contrario.
- **Ubicación del caché:**
  `~/.local/share/opencode/actsis-litellm/models-cache.json`
- **TTL por defecto:** 15 minutos (`catalogTtlMinutes`)
- **Sincronización forzada:** usa el tool `actsis_litellm_models` o el
  comando `/actsis-litellm-models`.
- **Actualización del selector de modelos:** OpenCode lee la lista de
  modelos al arrancar. Tras una sincronización del catálogo, **reinicia
  OpenCode** para ver los modelos nuevos en el selector.
- **Valores por defecto de contexto/salida:** `limit.context` y
  `limit.output` se establecen en `128000` y `16384` cuando el gateway no
  los reporta.
- **Mapeo de costos:** los costos de entrada/salida/caché de LiteLLM se
  mapean a los campos de costo de OpenCode por millón de tokens. Los valores
  ausentes o en cero se establecen en `0`. Cuando `/v1/model/info` falla o
  queda vacío, el plugin recurre al endpoint paginado `/v2/model/info` (hasta
  5 páginas de 100), y los precios escalonados de entrada/salida sobre
  128k/200k/272k/512k tokens se exponen como cost tiers nativos de OpenCode
  cuando el gateway los reporta.

## Tools y comandos

| Tool | Comando | Descripción |
|------|---------|-------------|
| `actsis_litellm_status` | `/actsis-litellm-status` | Muestra estado de credenciales, antigüedad y tamaño del caché del catálogo, URL del gateway e información de budget (recurre al último snapshot cacheado entre turnos). |
| `actsis_litellm_budget` | `/actsis-litellm-budget` | Fuerza una actualización del budget y reporta el resultado exacto (línea de gauge o el motivo preciso del fallo, además del último snapshot conocido cuando la lectura en vivo falla). |
| `actsis_litellm_models` | `/actsis-litellm-models` | Fuerza una sincronización fresca del catálogo de modelos y reporta modelos agregados/eliminados. |
| `actsis_litellm_usage` | `/actsis-litellm-usage` | Muestra gasto, tokens y peticiones por modelo para una ventana: sin argumentos (últimos 30 días), un número de días (`14`) o un rango explícito (`2025-03-01 .. 2025-03-31`). Ver [Uso por modelo](#uso-por-modelo). |
| `actsis_litellm_usage_subs` | `/actsis-litellm-usage-subs` | Muestra, por cada suscripción de Ollama Cloud, el porcentaje restante de la ventana de 5 horas y de la ventana semanal con el tiempo restante hasta el reinicio y los créditos, en formato tabular y con indicadores coloreados por nivel de uso, correlacionados con la ventana transcurrida (escalamiento por ritmo y proyección cuando el consumo va adelantado). Ver [Uso por suscripción](#uso-por-suscripción). |
| `actsis_litellm_top` | `/actsis-litellm-top` | Activa, desactiva o alterna el widget Top-5 de gasto de la TUI (`on \| off \| toggle`; sin argumentos alterna) y persiste la preferencia. Ver [Widget de la TUI](#widget-de-la-tui). |
| `actsis_litellm_logout` | `/actsis-litellm-logout` | Revoca el refresh token (OAuth), limpia el estado local y el caché. |

Los comandos son plantillas ligeras que indican al agente llamar al tool
correspondiente y resumir el resultado, de modo que funcionan tanto en modo
TUI como en modo servidor.

## Uso por modelo

La pareja `/actsis-litellm-usage` + tool `actsis_litellm_usage` muestra
gasto, tokens y peticiones agregados por modelo a partir de los registros de
gasto del gateway:

```
Usage 2025-02-26 → 2025-03-27 (30 UTC days): $1.2345
Model                      Spend  Tokens  Reqs
--------------------------------------------------
oc/gpt-x                 $0.9800   61.0k   130
oc/claude-y              $0.2545   28.0k    80
--------------------------------------------------
Total                    $1.2345   89.0k   210
```

- **Ventana:** sin argumentos → últimos 30 días inclusive; un número como
  `14` → últimos N días; un rango explícito e inclusivo
  `2025-03-01 .. 2025-03-31`.
- **Nombres públicos de modelo:** los logs de gasto de LiteLLM registran el
  nombre interno de despliegue (p. ej. `openai/glm-5.3-flash`); el comando
  los mapea a los aliases públicos del catálogo (`oc/glm-5.3-flash`) por id
  exacto o por sufijo compartido tras la última `/`, fusionando las filas
  que colisionan en el mismo modelo público. Los modelos sin alias público
  (p. ej. embeddings) conservan su nombre interno.
- **Paridad con el dashboard:** la consulta primaria usa
  `GET /user/daily/activity/aggregated` con un filtro `user_id` tomado de la
  credencial almacenada — totales estables en una sola llamada y delimitados
  al usuario propio ("Your Usage": un token admin sin el filtro vería el
  gasto de toda la org). Si el gateway no expone el endpoint agregado, el
  plugin recorre el endpoint paginado `GET /user/daily/activity` página a
  página y suma filas (los metadatos por página son page-scoped).
- **Nota de actividad del gateway:** la tabla cierra con una línea
  `Gateway requests:` proveniente de `GET /gateway/daily/activity`;
  el card *Total Requests* del dashboard cuenta las peticiones respondidas
  por el gateway (incluye tráfico no registrado en las tablas de gasto,
  p. ej. audio), por eso puede diferir de la columna `Reqs` de la tabla
  (intentos upstream, solo chat-completions).
- **Caveat:** LiteLLM solo calcula gasto para tráfico OpenAI-compatible de
  `/v1/chat/completions` (`/v1/messages`, passthrough y peticiones sin
  registro reportan cero o están ausentes).
- **Errores de permisos:** `401` se mapea a "inicia sesión de nuevo"; `403`
  indica que la credencial carece del permiso de las rutas de uso/gasto
  (acción de admin, reloguear no lo corrige).

## Fechas y zonas horarias

Las fechas de generación, vencimiento de credenciales y reinicio de presupuesto
y límites usan la zona horaria del sistema donde se ejecuta OpenCode. Se muestran
como `YYYY-MM-DD HH:mm (America/Bogota, GMT-05:00)`, con reloj de 24 horas y
el offset correspondiente al instante, incluidos los cambios de horario de verano.
No se requiere configurar una zona fija. Los valores no disponibles conservan
`-` para generación y `never` para vencimiento.

Las duraciones y la antigüedad de caché no dependen de la zona horaria.
`/actsis-litellm-usage` y Top models conservan sus límites de consulta por fechas
UTC y los identifican como `UTC days`; esto no presupone la zona de agregación
del gateway. Calcular totales por día local requeriría otro contrato del servidor.

## Uso por suscripción

La pareja `/actsis-litellm-usage-subs` + tool `actsis_litellm_usage_subs`
muestra el consumo de las suscripciones de Ollama Cloud del org tal como lo
presenta el panel administrativo del proveedor: porcentaje **restante** de la
ventana de 5 horas y de la ventana semanal, por suscripción, con tiempo restante
hasta el reinicio y créditos, agregado por el collector del gateway (`/ollama-usage`).
El formato es una tabla alineada con indicadores de barra coloreados según el
porcentaje usado (verde ≤ 50%, amarillo 51-75%, naranja 76-90%, rojo > 90%),
correlacionados con la fracción de la ventana ya transcurrida:

```text
Usage subscriptions (generated at 2026-10-14 09:56 (America/Bogota, GMT-05:00)):
Sub  5h used                5h resets in  Weekly used               Weekly resets in  Credits
----------------------------------------------------------------------------------------------
0    ▰▱▱▱▱▱▱▱ 18% 732 reqs  0 h 4 min     ▰▱▱▱▱▱▱▱ 12% 15,830 reqs  4 d 10 h          purchased $0.00
1    ▰▰▱▱▱▱▱▱ 19% 754 reqs  0 h 4 min     ▰▱▱▱▱▱▱▱ 13% 18,589 reqs  4 d 10 h          purchased $0.00
```

- **Tiempo hasta el reinicio:** horas/minutos para la ventana de 5 horas,
  días/horas para la semanal, calculados al mostrar el resultado y redondeados
  hacia arriba a la unidad visible. Reinicios vencidos muestran cero; fechas
  ausentes o inválidas muestran `-`.
- **Ventana y ritmo:** los colores comparan el porcentaje usado contra el
  porcentaje de ventana transcurrida, no solo el valor absoluto. Cuando el
  consumo va adelantado (ritmo = % usado / % transcurrido > 1, con piso de 10%
  transcurrido para que una ventana recién iniciada no dispare el cociente),
  el color escala un nivel de umbral y la celda agrega la proyección lineal
  del % usado al fin de la ventana (`15% → 150%`, con techo de 200%). En ritmo
  o debajo del ritmo, las celdas conservan los colores por umbral absoluto;
  sin límites de ventana conocidos (sin `from`/`until` y sin instante de
  reinicio) no hay correlación posible y queda el color por umbral absoluto.
- **Fuente de verdad:** los porcentajes vienen de la API oficial del
  proveedor (planes antiguos exponen `remaining_percent` por ventana en la
  API de balance; los planes de crédito exponen incluido/comprado en USD).
- **Una suscripción con error upstream** no bloquea al resto: su fila muestra
  `(error: …)` y las demás se sirven igual.
- Agregar una suscripción nueva es solo una variable de entorno en el gateway
  (`OLLAMA_CLOUD_KEY_<sufijo>`) más recargar el collector; este plugin no
  cambia.

## Widget de la TUI

Un widget opcional de la TUI renderiza el gauge de budget en el pie de la
barra lateral de OpenCode. Se activa agregando el spec del paquete al array
`plugins` de `~/.config/opencode/cli.json` — **además de** la entrada en
`opencode.json`; ambos archivos de configuración son necesarios (ver
[docs/installation.md](docs/installation.md)).

El widget lee el snapshot persistido en `session.idle` (fin de cada turno del
agente, y después de que `actsis_litellm_budget` lo refresque); se actualiza
al arrancar y tras cada turno con una breve espera (debounce) para que la
escritura del lado servidor gane la carrera. No renderiza nada cuando no hay
datos de budget.

### Filas Top-5 de modelos

Bajo la línea de Budget, el widget también renderiza las **Top-5 de modelos
por gasto** de los últimos 7 días: una línea de título `Top models (7d, UTC days) ·
$<total>` con su separador `=`, y hasta 5 filas con el nombre del modelo a la
izquierda, el gasto y el porcentaje de participación alineados a la derecha y
un gauge de 8 celdas por fila (mismo estilo que el gauge de Budget). El
relleno de columnas usa espacios no separables (NBSP) para que la alineación
tabular sobreviva a los sanitizadores de terminal que colapsan carreras de
espacios ASCII.

Las filas viajan por la misma tubería que el snapshot de budget (se
persisten en el `state.json` del plugin y se refrescan en `session.idle`, fin
de cada turno del agente) con una **TTL de 5 minutos**; cualquier fallo limpia
las filas silenciosamente y el bloque se oculta cuando no hay gasto en la
ventana. Los nombres de fila usan la misma resolución de alias público que la
tabla de [uso por modelo](#uso-por-modelo).

**Alterna el widget con `/actsis-litellm-top`:** sin argumentos lo alterna;
`on` / `off` lo fuerzan. La elección persiste entre sesiones en el archivo
propio del plugin
`~/.local/share/opencode/actsis-litellm/preferences.json` (clave
`"topModelsWidget"`; activado por defecto). Con `off` las filas se limpian de
inmediato y el plugin deja de consultar el gateway para el widget; con `on` se
refresca al momento.

### Nota de packaging

Los bundles de `dist/` están commiteados porque OpenCode instala paquetes de
git/npm con `--ignore-scripts`; un build de `prepack` nunca se ejecuta en la
máquina del usuario. Los shims raíz `index.js` y `tui.js` re-exportan los
bundles compilados (`dist/index.js` y `dist/tui.js`): el resolver de OpenCode
v2 para directorios locales solo prueba `<dir>/index` y `<dir>/tui` e ignora
el `package.json`. Los paquetes instalados por npm/git se resuelven en cambio
por los campos `main`/`exports`. Tras modificar `src/`, ejecuta
`npm run bundle` y commitea los `dist/` regenerados.

> **Por qué el script se llama `bundle` y no `build`:** al instalar desde un
> spec de git, el fetcher de npm (pacote) ejecuta un `npm install` completo
> del clon si el `package.json` declara un script `build` (o `prepare`,
> `prepack`, `preinstall`, `install`, `postinstall`) — incluso con
> `--ignore-scripts`. Si `npm` no está en el `PATH` de la máquina del
> usuario, la instalación falla con `git dep preparation failed`. Ninguno de
> esos nombres de script debe agregarse a este paquete.

## Arquitectura

Para los detalles técnicos — mapa de módulos de `src/`, puntos de integración
de OpenCode v2, contrato de provider/integraciones, comportamiento de
packaging y del loader de la TUI, y el ciclo de vida del snapshot de
budget — consulta:

- [`docs/architecture.md`](docs/architecture.md) — mapa de módulos y vista
  técnica general.
- [`docs/login-flow.md`](docs/login-flow.md) — la secuencia completa de login
  OAuth2 PKCE, la rotación de tokens y el flujo de logout.

## TLS con una CA privada (interna)

Node.js incluye una instantánea fija de las CAs raíz de Mozilla e ignora el
almacén de certificados del sistema operativo, de modo que un gateway cuyo
certificado HTTPS lo emitió una CA privada (habitual en entornos corporativos)
falla la validación dentro del login y del chat aunque la CA esté instalada
en el sistema (Windows `certmgr.msc` / `certlm.msc`).

Este plugin lo maneja de forma automática: al arrancar **carga las CAs del
sistema operativo por encima del set embebido de Node** (el comportamiento de
`--use-system-ca`, APIs de Node >= 22.19.0; en versiones anteriores queda en
un no-op seguro). Navegadores y HTTPS público siguen funcionando igual; los
gateways firmados por una CA interna se vuelven accesibles sin configuración
por máquina. La carga es estrictamente aditiva, se ejecuta una sola vez por
sesión, nunca bloquea el arranque si el manejo TLS falla y se puede desactivar.

- **Opt-out:** define `ACTSIS_LITELLM_NO_SYSTEM_CA=1` antes de iniciar
  OpenCode.
- **Si la confianza aún falla** (Node antiguo, almacenamiento inusual), el
  mensaje de error reporta la solución exacta por plataforma: Windows →
  `setx NODE_USE_SYSTEM_CA 1` (Node >= 22.19.0) o exportar la CA a PEM
  (`certutil -encode ca.cer ca.pem`) y fijarla en `NODE_EXTRA_CA_CERTS`;
  Linux → `--use-openssl-ca` / `SSL_CERT_FILE`. Nunca deshabilites la
  verificación TLS: confía en la CA emisora.

## Hardening de errores

El plugin clasifica los errores de límite del gateway mediante el hook de
sesión `http.response`, aplicado solo a este proveedor. Es una clasificación
informativa: registra una advertencia en el log y **no reescribe la
respuesta**.

- **Context overflow** — mensajes que coinciden con patrones de overflow de
  la ventana de contexto (`context_length_exceeded` y variantes) generan la
  advertencia `context overflow on model <modelID>`, lo que permite a la
  lógica de compactación de OpenCode reaccionar y recortar la conversación.
- **Budget agotado** — los errores estructurados de `budget_exceeded`
  generan una advertencia con el detalle del gasto y el límite, por ejemplo
  `Budget exceeded: $<spend> of $<max> used — top up the key budget or wait
  for the reset.`
- **Throttling (429)** — los errores de `throttling_error` generan una
  advertencia con el tipo de rate limit y la hora de reinicio, por ejemplo
  `Rate limit reached (tpm). Resets at 14:32 (~3 min).`
- **Causa raíz de las fallas de red** — los fallos de transporte ya no se
  reportan como el opaco `TypeError: fetch failed`: el mensaje nombra la
  causa real escondida en la cadena de causas (`ENOTFOUND`, `ECONNREFUSED`,
  códigos de confianza TLS como `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`,
  `ETIMEDOUT`, `ECONNRESET`) con una sugerencia accionable para las clases
  conocidas (DNS/VPN, gateway caído, remediación TLS de
  [la sección TLS](#tls-con-una-ca-privada-interna)). Aplica al discovery,
  al registro de cliente, al intercambio/refresh/revocación de tokens, al
  catálogo, al budget y a los endpoints de uso; una falla de red nunca se
  confunde con una credencial rechazada.

Para una respuesta accionable al usuario, los tools `actsis_litellm_status`
y `actsis_litellm_budget` reportan el motivo exacto de cada fallo (sin
credencial, URL del gateway sin configurar, credencial rechazada, error de
red/timeout).

## Troubleshooting

| Síntoma | Qué hacer |
|---------|----------|
| Proveedor sin configurar / falta la URL del gateway | Ejecuta `opencode auth login`, selecciona `actsis-litellm` e introduce la URL del gateway. O define `ACTSIS_LITELLM_URL` / agrega `url` a las opciones del plugin. |
| El login expiró | La ventana del callback loopback es de 5 minutos. Si el paso del navegador tomó más tiempo, ejecuta `opencode auth login` de nuevo. |
| Refresh rechazado (`invalid_grant`) | El refresh token de OAuth expiró, fue rotado en otro lugar o fue revocado. Inicia sesión de nuevo. |
| Los modelos no aparecen en el selector | Ejecuta `/actsis-litellm-models` para forzar la sincronización y luego reinicia OpenCode. Revisa el conteo del caché con `/actsis-litellm-status`. |
| El gateway rechaza la credencial | Para OAuth (browser), inicia sesión de nuevo para obtener tokens frescos. Para API keys, verifica la clave en la UI del gateway y vuelve a iniciar sesión — la clave solo se comprueba por el gateway en el primer uso, no durante el login. |
| La credencial sigue activa tras `actsis_litellm_logout` | El tool revoca el refresh token y limpia el estado local, pero la credencial guardada en el almacén de integraciones de OpenCode debe desconectarse desde la UI de auth nativa: no existe una API de plugin para borrarla. |
| Un error nombra la causa de red (DNS, conexión rechazada, TLS, timeout, reset) en vez de `fetch failed` | Los fallos de transporte reportan su causa real con sugerencias accionables. Si la causa es un código TLS contra un gateway con CA interna (`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, `SELF_SIGNED_CERT_IN_CHAIN`, ...): instala la CA emisora en el almacén de confianza del SO y arranca Node con `--use-system-ca`, o apunta `NODE_EXTRA_CA_CERTS` al bundle de la CA. Ver [TLS con una CA privada (interna)](#tls-con-una-ca-privada-interna). |

## Notas de seguridad

- El servidor callback de OAuth se enlaza únicamente a `127.0.0.1` en un
  puerto efímero y atiende una sola petición `/callback` por login.
- No se incluye ningún hostname del gateway, IP, token ni dato identificable
  de usuario ni en el paquete ni en este repositorio.
- OAuth, credenciales y API keys los almacena OpenCode en su almacén nativo
  de integraciones (SQLite en `~/.local/share/opencode/opencode.db`); el
  plugin no escribe tokens por sí mismo. El antiguo `auth.json` solo se lee
  como fallback legado para instalaciones previas a v2.
- El archivo de estado propio del plugin,
  `~/.local/share/opencode/actsis-litellm/state.json`, contiene solo
  metadatos no secretos del gateway (URL, snapshot de discovery, client ID,
  modo de autenticación). No se almacenan tokens ahí.
- Ningún token ni URL del gateway aparece en los archivos de configuración de
  OpenCode.

## Licencia

MIT — ver [`LICENSE`](LICENSE).

---

<p align="center">
  <a href="https://github.com/Gentleman-Programming/gentle-ai">
    <img width="220" src="https://raw.githubusercontent.com/Gentleman-Programming/gentle-ai/main/docs/assets/brand/built-with-gentle-ai.png" alt="Built with Gentle-AI" />
  </a>
</p>
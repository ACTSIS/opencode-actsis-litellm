# opencode-actsis-litellm

Plugin de [OpenCode](https://opencode.ai) que agrega un gateway **Actsis
LiteLLM** como proveedor de modelos dinámico, con inicio de sesión OAuth2 PKCE
(SSO), autenticación opcional por API key y un catálogo de modelos dinámico.

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
   - **SSO (browser)** — flujo OAuth2 Authorization Code con PKCE (S256). Se
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
| **SSO (browser)** | OAuth2 Authorization Code + PKCE (S256). El plugin obtiene los metadatos de discovery en `/.well-known/litellm-cli-auth`, registra el cliente de forma dinámica, abre el navegador y captura la redirección en un servidor callback exclusivamente loopback (`127.0.0.1`, puerto efímero). La ventana del callback es de **5 minutos**. OpenCode almacena los tokens de acceso y refresh y los rota en cada renovación. |
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
| `actsis_litellm_models` | `/actsis-litellm-models` | Fuerza una sincronización fresca del catálogo de modelos y reporta modelos agregados/eliminados. |
| `actsis_litellm_logout` | `/actsis-litellm-logout` | Revoca el refresh token (SSO), limpia el estado local y el caché. |
| `actsis_litellm_budget` | `/actsis-litellm-budget` | Fuerza una actualización del budget y reporta el resultado exacto (línea de gauge o el motivo preciso del fallo, además del último snapshot conocido cuando la lectura en vivo falla). |

Los comandos son plantillas ligeras que indican al agente llamar al tool
correspondiente y resumir el resultado, de modo que funcionan tanto en modo
TUI como en modo servidor.

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

### Nota de packaging

Los bundles de `dist/` están commiteados porque OpenCode instala paquetes de
git/npm con `--ignore-scripts`; un build de `prepack` nunca se ejecuta en la
máquina del usuario. Los shims raíz `index.js` y `tui.js` re-exportan los
bundles compilados (`dist/index.js` y `dist/tui.js`): el resolver de OpenCode
v2 para directorios locales solo prueba `<dir>/index` y `<dir>/tui` e ignora
el `package.json`. Los paquetes instalados por npm/git se resuelven en cambio
por los campos `main`/`exports`. Tras modificar `src/`, ejecuta
`npm run build` y commitea los `dist/` regenerados.

## Arquitectura

Para los detalles técnicos — mapa de módulos de `src/`, puntos de integración
de OpenCode v2, contrato de provider/integraciones, comportamiento de
packaging y del loader de la TUI, y el ciclo de vida del snapshot de
budget — consulta:

- [`docs/architecture.md`](docs/architecture.md) — mapa de módulos y vista
  técnica general.
- [`docs/login-flow.md`](docs/login-flow.md) — la secuencia completa de login
  OAuth2 PKCE, la rotación de tokens y el flujo de logout.

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

Para una respuesta accionable al usuario, los tools `actsis_litellm_status`
y `actsis_litellm_budget` reportan el motivo exacto de cada fallo (sin
credencial, URL del gateway sin configurar, credencial rechazada, error de
red/timeout).

## Troubleshooting

| Síntoma | Qué hacer |
|---------|----------|
| Proveedor sin configurar / falta la URL del gateway | Ejecuta `opencode auth login`, selecciona `actsis-litellm` e introduce la URL del gateway. O define `ACTSIS_LITELLM_URL` / agrega `url` a las opciones del plugin. |
| El login expiró | La ventana del callback loopback es de 5 minutos. Si el paso del navegador tomó más tiempo, ejecuta `opencode auth login` de nuevo. |
| Refresh rechazado (`invalid_grant`) | El refresh token de SSO expiró, fue rotado en otro lugar o fue revocado. Inicia sesión de nuevo. |
| Los modelos no aparecen en el selector | Ejecuta `/actsis-litellm-models` para forzar la sincronización y luego reinicia OpenCode. Revisa el conteo del caché con `/actsis-litellm-status`. |
| El gateway rechaza la credencial | Para SSO, inicia sesión de nuevo para obtener tokens frescos. Para API keys, verifica la clave en la UI del gateway y vuelve a iniciar sesión — la clave solo se comprueba por el gateway en el primer uso, no durante el login. |
| La credencial sigue activa tras `actsis_litellm_logout` | El tool revoca el refresh token y limpia el estado local, pero la credencial guardada en el almacén de integraciones de OpenCode debe desconectarse desde la UI de auth nativa: no existe una API de plugin para borrarla. |

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
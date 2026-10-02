# Guía de instalación

Esta es la guía de instalación autorizada y paso a paso para el plugin
`opencode-actsis-litellm` (plugin de servidor + widget de budget para la TUI).
El [README](../README.md) mantiene un inicio rápido breve; este documento es
la referencia completa.

Todas las URLs del gateway en los ejemplos usan el placeholder seguro
`https://your-gateway.example.com` — reemplázalo por la URL base de tu
gateway al configurar.

## Requisitos

- **OpenCode >= 2.0.0** (declarado en los `engines` del plugin; verificado
  contra **v2.0.20**). El widget de budget para la TUI también fue verificado
  en OpenCode **2.0.20**.
- **No requiere instalación manual de dependencias.** El plugin corre sobre
  el runtime Bun embebido en OpenCode. Paquetes peers como `@opentui/core`,
  `@opentui/solid` y `solid-js` solo son necesarios para **compilar el plugin
  desde el código fuente** (son devDependencies); los usuarios finales que
  instalan desde GitHub o npm no instalan nada a mano.

## Instalación recomendada: spec de GitHub

Agrega el spec del paquete a **ambos** archivos de configuración de OpenCode:

1. `~/.config/opencode/opencode.json` — registra el **plugin de servidor**
   (proveedor, auth, tools y comandos):

   ```json
   {
     "plugins": ["github:ACTSIS/opencode-actsis-litellm"]
   }
   ```

2. `~/.config/opencode/cli.json` — registra el **widget de budget** para la
   TUI (mismo spec, archivo separado):

   ```json
   {
     "plugins": ["github:ACTSIS/opencode-actsis-litellm"]
   }
   ```

La forma abreviada `git:github.com/ACTSIS/opencode-actsis-litellm` también es
aceptada en ambos archivos.

> **Requisito de configuración dual:** el array `plugins` vive en dos
> archivos con roles distintos. Solo `opencode.json` te da el proveedor, el
> login, los tools y los comandos; solo `cli.json` te da el widget de budget
> de la barra lateral. Para la experiencia completa, agrega el spec a
> **ambos** archivos. Esto aplica a todos los métodos de instalación, no
> solo al spec de GitHub. En OpenCode v1 la clave era `"plugin"` (singular) y
> el widget se configuraba en `tui.json`; ambas formas ya no existen en v2.

### Alternativas

La misma regla de configuración dual aplica a las demás formas de spec
soportadas:

- **Paquete npm** (una vez publicado el paquete en npm):

  ```json
  {
    "plugins": ["opencode-actsis-litellm"]
  }
  ```

- **Ruta local de desarrollo** (un clon de este repositorio):

  ```json
  {
    "plugins": ["/ruta/a/opencode-actsis-litellm"]
  }
  ```

Usa el mismo spec en `~/.config/opencode/opencode.json` **y** en
`~/.config/opencode/cli.json`. Para rutas locales, OpenCode v2 resuelve los
directorios de plugins únicamente probando `<dir>/index` y `<dir>/tui` en la
raíz del paquete, ignorando `package.json` `main`/`exports`; por eso el
repositorio incluye los shims raíz `index.js` y `tui.js` que re-exportan los
bundles de `dist/` (ver la nota de packaging al final de este documento).

## Walkthrough de login

Inicia OpenCode y ejecuta:

```
opencode auth login
```

1. **Selecciona el proveedor.** Escoge `actsis-litellm` (nombre visible
   "Actsis LiteLLM") de la lista de proveedores.
2. **Prompt de URL del gateway (condicional).** La URL solo se pregunta
   **cuando no está ya resuelta**. Precedencia de resolución (de mayor a
   menor):
   1. Variable de entorno `ACTSIS_LITELLM_URL`
   2. Opciones del plugin (forma objeto `{ package, options }` en
      `opencode.json`)
   3. Estado del plugin almacenado
      (`~/.local/share/opencode/actsis-litellm/state.json`, escrito por un
      login anterior)
   4. Prompt interactivo
3. **Método de inicio de sesión.** Elige **SSO (browser)** o **API key**:
   - **SSO** — flujo OAuth2 Authorization Code con PKCE (S256). Se abre tu
     navegador, inicias sesión a través de tu proveedor de identidad y el
     gateway redirige a un callback loopback (`127.0.0.1`, puerto efímero).
     La ventana del callback es de **5 minutos** — completa el paso del
     navegador dentro de ese tiempo.
   - **API key** — el prompt nativo de OpenCode ("Enter your API key")
     captura la clave directamente; la clave nunca pasa por el plugin. Se
     guarda en el almacén de credenciales del store nativo de integraciones
     de OpenCode y es **validada por el gateway en el primer uso**, no
     durante el login.

Las credenciales las persiste OpenCode en su almacén nativo de
integraciones (SQLite en `~/.local/share/opencode/opencode.db`, tabla
`credential`). El plugin guarda solo metadatos no secretos del gateway en
`~/.local/share/opencode/actsis-litellm/state.json`. El antiguo
`~/.local/share/opencode/auth.json` de v1 se lee únicamente como fallback
legado para instalaciones previas a v2.

## Checklist de verificación post-instalación

Tras instalar e iniciar sesión, verifica cada ítem:

- [ ] **Proveedor registrado** — `actsis-litellm` (nombre visible
      "Actsis LiteLLM") aparece en la lista de proveedores de
      `opencode auth login`.
- [ ] **Credencial y caché visibles** — `/actsis-litellm-status` reporta el
      estado de la credencial (SSO/API key), la URL del gateway, y la
      antigüedad y el conteo de modelos del caché del catálogo.
- [ ] **El catálogo se sincroniza** — `/actsis-litellm-models` ejecuta una
      sincronización fresca y reporta los modelos agregados/eliminados.
- [ ] **Selector de modelos actualizado** — OpenCode lee la lista de modelos
      al arrancar. Tras la primera sincronización del catálogo, **reinicia
      OpenCode** para que los modelos nuevos aparezcan en el selector.
- [ ] **El widget de budget renderiza** — en la TUI, el gauge de budget
      (`▰▰▰▱▱▱▱▱ 42% · $12.40 of $30.00`) aparece en el **pie de la barra
      lateral** una vez que existen datos de budget (el plugin persiste un
      snapshot al final de cada turno; el widget no renderiza nada cuando no
      hay datos).

## Troubleshooting

| Síntoma | Qué hacer |
|---------|-----------|
| **El proveedor no aparece en `opencode auth login`** | El caché de plugins puede haber quedado vacío tras una instalación fallida o parcial. Reinstala el plugin (ambos archivos de configuración) y reinicia OpenCode para que se registre de nuevo. |
| **El widget de budget no renderiza** | Verifica que exista la entrada en `cli.json`. El widget requiere una compilación de la TUI con soporte de plugins. Para un plugin de directorio local, el loader de la TUI de OpenCode v2 resuelve `<dir>/tui.js` (shim raíz que re-exporta `dist/tui.js`, un `Plugin.define({ id, setup })` v2); las entradas `src/*.tsx` crudas no se resuelven. Los paquetes npm/git se resuelven por `main`/`exports`. |
| **Modelos ausentes en el selector** | Ejecuta `/actsis-litellm-models` para forzar la sincronización, revisa el conteo de modelos del caché con `/actsis-litellm-status`, y **reinicia OpenCode** (el selector se refresca al arrancar). |
| **El login expira** | La ventana del callback loopback de SSO es de 5 minutos. Si el paso del navegador tomó más tiempo, ejecuta `opencode auth login` de nuevo. |
| **Refresh rechazado (`invalid_grant`)** | El refresh token de SSO expiró, fue rotado en otro lugar o fue revocado. Inicia sesión de nuevo con `opencode auth login`. |
| **El gateway rechaza la credencial** | Las API keys no se pre-validan durante el login; el gateway las valida en el primer uso. Verifica la clave en la UI del gateway e inicia sesión de nuevo. Para SSO, inicia sesión de nuevo para obtener tokens frescos. |

## Nota de packaging: por qué `dist/` está commiteado

OpenCode instala paquetes de npm/git con `--ignore-scripts`, por lo que un
paso de build `prepack` **nunca se ejecuta** en la máquina del usuario. Para
que las instalaciones funcionen sin ningún paso de build, los bundles
compilados de `dist/` están **commiteados en el repositorio** y se
regeneran cada vez que cambia `src/` (`npm run build` y commit de los nuevos
`dist/`).

V2 resuelve los paquetes instalados de forma distinta según el mecanismo de
instalación:

- **Paquetes npm/git:** el loader resuelve por el contrato de entrypoints del
  `package.json` — `main` (y la export `"."`) apunta al bundle del servidor
  (`dist/index.js`), y la export `"./tui"` apunta al bundle de la CLI
  (`dist/tui.js`):

  ```json
  {
    "main": "./dist/index.js",
    "exports": {
      ".": { "import": "./dist/index.js" },
      "./tui": { "import": "./dist/tui.js" }
    }
  }
  ```

- **Directorios locales:** el resolver de OpenCode v2 solo prueba
  `<dir>/index` y `<dir>/tui` en la raíz del paquete e ignora
  `package.json` `main`/`exports`. Por eso el repositorio incluye los shims
  raíz `index.js` y `tui.js`, que re-exportan `dist/index.js` y
  `dist/tui.js` respectivamente.

Las entradas crudas `src/*.ts`/`src/*.tsx` se omiten silenciosamente por el
loader. Si compilas desde el código fuente, ejecuta `npm run build` y
commitea los `dist/` regenerados antes de instalar desde una ruta local.
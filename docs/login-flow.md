# Secuencia del flujo de login

El proveedor `actsis-litellm` implementa OAuth2 Authorization Code + PKCE
como un **método de integración** de OpenCode v2 (registrado vía
`ctx.integration.transform` → `editor.method.update(...)`), invocado por el
flujo nativo de `opencode auth login`. Todas las URLs de red en este
documento usan placeholders como `https://your-gateway.example.com`; no se
commitea ningún hostname ni token real.

## Pasos

1. **Prompts.** Ejecutas `opencode auth login` y seleccionas
   `actsis-litellm`.
   - El **prompt de URL del gateway** aparece solo cuando la URL no está ya
     resuelta desde la variable de entorno `ACTSIS_LITELLM_URL`, las
     opciones del plugin o el estado almacenado del plugin (la entrada se
     valida como URL `http(s)`).
   - El **selector de método de inicio de sesión** ofrece
     **SSO (browser)** o **API key**.
2. **Autorización (camino SSO).**
   1. **Discovery** — el plugin obtiene `/.well-known/litellm-cli-auth` del
      gateway y valida el contrato (`contract_version: 1`, método de
      challenge `S256` obligatorio). Si el gateway anuncia un endpoint
      `http://`, el plugin lo promueve a `https://` y recuerda la
      promoción (`schemeUpgraded`).
   2. **Registro dinámico de cliente** — se registra un cliente OAuth
      público contra el `registration_endpoint` del discovery (redirect
      exclusivamente loopback).
   3. **PKCE** — se genera un `code_verifier` aleatorio y se hashea (S256)
      en un `code_challenge`; un parámetro `state` aleatorio protege el
      callback.
   4. **Navegador** — OpenCode abre la URL de autorización. Te autenticas a
      través de tu proveedor de identidad.
3. **Callback loopback.** El gateway redirige a
   `http://127.0.0.1:<puerto efímero>/callback?code=...&state=...`. Un
   servidor local enlazado a `127.0.0.1` captura el código, valida `state`,
   y la ventana de **5 minutos** se cierra al terminar.
4. **Intercambio de tokens.** El plugin intercambia el código de
   autorización (con el verifier PKCE) en el token endpoint por un access
   token y un refresh token.
5. **Devolución de la credencial a la integración.** El callback `authorize`
   del método OAuth resuelve con un `Credential.OAuth` de v2:
   `{ type: "oauth", methodID, refresh, access, expires, metadata: { userId,
   teamId } }`. OpenCode persiste esa credencial en su **almacén nativo de
   integraciones** (SQLite `~/.local/share/opencode/opencode.db`, tabla
   `credential`), no en un archivo JSON.
6. **Archivo de estado del plugin.** El plugin registra en
   `~/.local/share/opencode/actsis-litellm/state.json` un snapshot de
   discovery del gateway — URL del gateway, provider ID, client ID,
   token/revocation endpoints, `resource`, modo de auth y flag de
   promoción de esquema — sin tokens.
7. **Refresh (por renovación).** Cuando OpenCode decide renovar, invoca el
   callback `refresh(credential)` del método de integración, que ejecuta
   `ensureFreshToken` (ver [Rotación de refresh tokens](#rotación-de-refresh-tokens))
   y devuelve la credencial OAuth completa; OpenCode persiste el resultado.

## Diagrama del flujo

```
opencode auth login
        │
        ▼
[1] Prompts ── URL del gateway (solo si no está configurada) ──▶ método: SSO / API key
        │
        ├──────────── SSO (browser) ────────────┐         API key
        ▼                                       │            │
[2] Discovery       GET /.well-known/litellm-cli-auth        │
        ▼                                       │            ▼
[2] Registro dinámico de cliente (público, loopback)      │   Prompt nativo del CLI
        ▼                                       │   "Enter your API key"
[2] PKCE S256 + state aleatorio                      │            │
        ▼                                       │            │
[2] OpenCode abre el navegador ── usuario inicia sesión ────┘            │
        ▼                                                            │
[3] Callback loopback   127.0.0.1:<efímero>/callback                     │
    code + state capturados, state validado (ventana de 5 min)          │
        ▼                                                            │
[4] Intercambio de tokens   code + verifier ──▶ access + refresh        │
        ▼                                                            │
[5] Callback authorize ──▶ Credential.OAuth ──▶ almacén nativo de       │
    integraciones de OpenCode (opencode.db, tabla credential) ◄─────────┘
        ▼
[6] Archivo de estado del plugin   snapshot del gateway (sin tokens)
        ▼
[7] Renovación   callback refresh(credential) · ensureFreshToken
    · OpenCode persiste la credencial rotada
```

## Camino de API key (método nativo)

1. El CLI de OpenCode pregunta de forma nativa "Enter your API key" y
   captura el valor él mismo — la clave nunca pasa por el plugin.
2. El plugin registra `gatewayUrl` y `authMode: "api_key"` en el archivo de
   estado del plugin (`state.json`) y devuelve el método sin pre-validar la
   clave.
3. OpenCode persiste la API key en su almacén nativo de integraciones
   (`opencode.db`, tabla `credential`).

La clave no se pre-valida durante el login; el gateway la valida en la
primera petición.

## Rotación de refresh tokens

Para credenciales SSO, el callback `refresh(credential)` del método de
integración (`ensureFreshToken`) corre cuando OpenCode solicita una
renovación (el gateway rota el refresh token en cada renovación):

1. Lee el estado del refresh (token endpoint, client ID, `resource`) del
   archivo de estado del plugin.
2. Intercambia el `refresh_token` por un nuevo `access_token` y un
   `refresh_token` rotado (cuando el access token está dentro de una
   ventana proactiva de 300 segundos antes de expirar).
3. Devuelve el `Credential.OAuth` completo; **OpenCode persiste los nuevos
   tokens** en su almacén nativo de integraciones (el plugin no escribe
   tokens).

Las credenciales de API key nunca se renuevan; se inyectan directamente
como token `Bearer`.

## Snapshot de budget post-turno

En `session.idle` (fin de cada turno del agente) el plugin refresca el
budget desde el gateway y persiste un snapshot — `lastBudgetSnapshot` más
una marca `budgetRefreshedAt` — en el archivo de estado del plugin
(`state.json`). Este snapshot es el que usan como fallback los tools
`actsis_litellm_status` y `actsis_litellm_budget` cuando un fetch en vivo
falla, y el que renderiza el widget de budget en la TUI (ver
[architecture.md](architecture.md) para el ciclo de vida completo).

## Logout

`/actsis-litellm-logout` (o el tool `actsis_litellm_logout`):

1. Revoca el refresh token en el revocation endpoint del gateway (mejor
   esfuerzo; los fallos de red se toleran porque el token expira
   localmente).
2. Limpia el estado del plugin (lo restablece a `{ version: 1 }`) y elimina
   el archivo de caché de modelos.
3. La credencial guardada en el almacén de integraciones de OpenCode se
   desconecta desde la **UI de auth nativa** de OpenCode: no existe una API
   de plugin para borrarla, por eso el tool lo informa explícitamente en su
   salida.

## Notas de seguridad

- El servidor callback loopback se enlaza solo a `127.0.0.1` y maneja una
  única petición `/callback`.
- Los callbacks pendientes se buferean y se emparejan por el parámetro
  `state` original.
- PKCE usa un challenge `S256` y un `state` aleatorio para prevenir CSRF e
  intercepción del código de autorización.
- El plugin no almacena tokens; las credenciales viven en el almacén nativo
  de integraciones de OpenCode, y el archivo de estado del plugin contiene
  solo metadatos no secretos.
- Todas las URLs placeholder de este documento son seguras para uso público.
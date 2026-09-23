// src/errors.ts
var ActsisLiteLLMError = class extends Error {
  code;
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
    this.name = this.constructor.name;
  }
};
var ConfigError = class extends ActsisLiteLLMError {
  constructor(message, options) {
    super("CONFIG_ERROR", message, options);
  }
};
var DiscoveryError = class extends ActsisLiteLLMError {
  constructor(message, options) {
    super("DISCOVERY_ERROR", message, options);
  }
};
var AuthError = class extends ActsisLiteLLMError {
  constructor(message, options) {
    super("AUTH_ERROR", message, options);
  }
};
var CatalogError = class extends ActsisLiteLLMError {
  constructor(message, options) {
    super("CATALOG_ERROR", message, options);
  }
};

// src/client.ts
function getOrigin(url) {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`.toLowerCase();
}
function normalizeOrigin(origin) {
  return origin.replace(/\/+$/, "").toLowerCase();
}
function parseHttpUrl(value, name) {
  if (typeof value !== "string") {
    throw new DiscoveryError(`${name} must be a string`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new DiscoveryError(`${name} is not a valid URL: ${value}`);
  }
  if (!url.protocol.startsWith("http")) {
    throw new DiscoveryError(
      `${name} must use http:// or https://: ${value}`
    );
  }
  return url;
}
function requireSameOrigin(baseOrigin, value, name) {
  const url = parseHttpUrl(value, name);
  const endpointOrigin = getOrigin(value);
  if (endpointOrigin === baseOrigin) {
    return { value, upgraded: false };
  }
  const baseParsed = new URL(baseOrigin);
  if (url.host.toLowerCase() !== baseParsed.host.toLowerCase() || url.protocol.toLowerCase() !== "http:" || baseParsed.protocol.toLowerCase() !== "https:") {
    throw new DiscoveryError(
      `${name} must be same-origin with the gateway (${baseOrigin}), got ${endpointOrigin}`
    );
  }
  const upgraded = value.replace(/^http:/i, "https:");
  return { value: upgraded, upgraded: true };
}
function validateDiscoveryWithAdaptation(raw, baseUrl) {
  if (typeof raw !== "object" || raw === null) {
    throw new DiscoveryError("Discovery response is not an object");
  }
  const record = raw;
  if (record.contract_version !== 1) {
    throw new DiscoveryError(
      `Unsupported CLI auth contract version: ${String(record.contract_version)}`
    );
  }
  const expectedOrigin = normalizeOrigin(getOrigin(baseUrl));
  if (typeof record.issuer !== "string" || !record.issuer.startsWith("http")) {
    throw new DiscoveryError(
      `Discovery issuer is missing or not an HTTP URL: ${String(record.issuer)}`
    );
  }
  const issuerOrigin = getOrigin(record.issuer);
  let issuer = record.issuer;
  let adaptation = null;
  if (issuerOrigin !== expectedOrigin) {
    const issuerParsed = parseHttpUrl(record.issuer, "issuer");
    const baseParsed = new URL(expectedOrigin);
    const sameHost = issuerParsed.host.toLowerCase() === baseParsed.host.toLowerCase();
    const allowedDirection = issuerParsed.protocol.toLowerCase() === "http:" && baseParsed.protocol.toLowerCase() === "https:";
    if (!sameHost || !allowedDirection) {
      throw new DiscoveryError(
        `Discovery issuer origin mismatch: expected ${expectedOrigin}, got ${issuerOrigin}`
      );
    }
    const upgradedIssuer = record.issuer.replace(/^http:/i, "https:");
    adaptation = {
      kind: "scheme-upgraded",
      announcedIssuer: record.issuer,
      effectiveIssuer: upgradedIssuer
    };
    issuer = upgradedIssuer;
  }
  const authorizationEndpoint = requireSameOrigin(
    expectedOrigin,
    record.authorization_endpoint,
    "authorization_endpoint"
  );
  const tokenEndpoint = requireSameOrigin(
    expectedOrigin,
    record.token_endpoint,
    "token_endpoint"
  );
  const registrationEndpoint = requireSameOrigin(
    expectedOrigin,
    record.registration_endpoint,
    "registration_endpoint"
  );
  const revocationEndpoint = requireSameOrigin(
    expectedOrigin,
    record.revocation_endpoint,
    "revocation_endpoint"
  );
  const resourceUrl = parseHttpUrl(record.resource, "resource");
  const resourceOrigin = getOrigin(record.resource);
  const resourceMatchesAnnounced = resourceOrigin === issuerOrigin;
  const resourceMatchesEffective = resourceOrigin === expectedOrigin;
  if (!resourceMatchesAnnounced && !resourceMatchesEffective) {
    requireSameOrigin(expectedOrigin, record.resource, "resource");
  }
  const resource = record.resource;
  const codeChallengeMethods = Array.isArray(record.code_challenge_methods_supported) ? record.code_challenge_methods_supported.map((m) => String(m)) : [];
  if (!codeChallengeMethods.includes("S256")) {
    throw new DiscoveryError(
      "Discovery does not advertise PKCE S256 code challenge method"
    );
  }
  const grantTypes = Array.isArray(record.grant_types_supported) ? record.grant_types_supported.map((g) => String(g)) : [];
  if (!grantTypes.includes("authorization_code")) {
    throw new DiscoveryError(
      "Discovery does not advertise authorization_code grant type"
    );
  }
  if (!grantTypes.includes("refresh_token")) {
    throw new DiscoveryError(
      "Discovery does not advertise refresh_token grant type"
    );
  }
  const tokenEndpointAuthMethods = Array.isArray(
    record.token_endpoint_auth_methods_supported
  ) ? record.token_endpoint_auth_methods_supported.map((m) => String(m)) : [];
  return {
    discovery: {
      contractVersion: 1,
      issuer,
      authorizationEndpoint: authorizationEndpoint.value,
      tokenEndpoint: tokenEndpoint.value,
      registrationEndpoint: registrationEndpoint.value,
      revocationEndpoint: revocationEndpoint.value,
      resource,
      codeChallengeMethods,
      grantTypes,
      tokenEndpointAuthMethods
    },
    adaptation
  };
}
function discoveryUrl(baseUrl) {
  const normalized = baseUrl.replace(/\/+$/, "");
  return `${normalized}/.well-known/litellm-cli-auth`;
}
async function fetchCliAuthDiscovery(baseUrl, timeoutMs, onAdaptation, fetchImpl = globalThis.fetch) {
  let response;
  try {
    response = await fetchImpl(discoveryUrl(baseUrl), {
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    throw new DiscoveryError(
      `Failed to fetch CLI auth discovery: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
  if (!response.ok) {
    throw new DiscoveryError(
      `Discovery endpoint returned ${response.status}: ${response.statusText}`
    );
  }
  let body;
  try {
    body = await response.json();
  } catch (err) {
    throw new DiscoveryError(
      `Discovery response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
  const { discovery, adaptation } = validateDiscoveryWithAdaptation(body, baseUrl);
  if (adaptation) {
    onAdaptation?.(adaptation);
  }
  return discovery;
}
function extractErrorDescription(body) {
  if (typeof body !== "object" || body === null) return "";
  const error = body.error;
  const description = body.error_description;
  const parts = [];
  if (typeof error === "string" && error) parts.push(error);
  if (typeof description === "string" && description) parts.push(description);
  return parts.join(" \u2014 ");
}
async function registerClient(discovery, redirectUri, timeoutMs, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(discovery.registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "opencode-actsis-litellm",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"]
    }),
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("Location") ?? "unknown";
    throw new AuthError(
      `Client registration redirected unexpectedly to ${location}. Refusing to send credentials to another origin.`
    );
  }
  if (!response.ok) {
    let body2;
    try {
      body2 = await response.json();
    } catch {
      body2 = null;
    }
    const description = extractErrorDescription(body2) || `${response.status}: ${response.statusText}`;
    throw new AuthError(`Client registration failed: ${description}`);
  }
  let body;
  try {
    body = await response.json();
  } catch (err) {
    throw new AuthError(
      `Client registration response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
  if (typeof body !== "object" || body === null) {
    throw new AuthError("Client registration response is not an object");
  }
  const record = body;
  if (typeof record.client_id !== "string" || !record.client_id) {
    throw new AuthError(
      "Client registration response missing client_id"
    );
  }
  return {
    clientId: record.client_id,
    redirectUris: Array.isArray(record.redirect_uris) ? record.redirect_uris.map((u) => String(u)) : [redirectUri]
  };
}
async function exchangeAuthorizationCode(discovery, input, timeoutMs, fetchImpl = globalThis.fetch) {
  const params = new URLSearchParams();
  params.set("grant_type", "authorization_code");
  params.set("code", input.code);
  params.set("redirect_uri", input.redirectUri);
  params.set("client_id", input.clientId);
  params.set("code_verifier", input.codeVerifier);
  params.set("resource", discovery.resource);
  const response = await fetchImpl(discovery.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("Location") ?? "unknown";
    throw new AuthError(
      `Token endpoint redirected unexpectedly to ${location}. Refusing to replay authorization code to another origin.`
    );
  }
  let body;
  try {
    body = await response.json();
  } catch (err) {
    throw new AuthError(
      `Token response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
  if (!response.ok) {
    const description = extractErrorDescription(body) || `${response.status}: ${response.statusText}`;
    throw new AuthError(`Authorization code exchange failed: ${description}`);
  }
  if (typeof body !== "object" || body === null) {
    throw new AuthError("Token response is not an object");
  }
  const record = body;
  if (typeof record.access_token !== "string" || !record.access_token) {
    throw new AuthError("Token response missing access_token");
  }
  return {
    accessToken: record.access_token,
    tokenType: typeof record.token_type === "string" ? record.token_type : "Bearer",
    expiresIn: typeof record.expires_in === "number" && Number.isFinite(record.expires_in) ? record.expires_in : 3600,
    refreshToken: typeof record.refresh_token === "string" && record.refresh_token ? record.refresh_token : null,
    userId: typeof record.user_id === "string" && record.user_id ? record.user_id : void 0,
    teamId: typeof record.team_id === "string" && record.team_id ? record.team_id : void 0
  };
}
async function refreshGrant(discovery, input, timeoutMs, fetchImpl = globalThis.fetch) {
  const params = new URLSearchParams();
  params.set("grant_type", "refresh_token");
  params.set("refresh_token", input.refreshToken);
  params.set("client_id", input.clientId);
  params.set("resource", discovery.resource);
  const response = await fetchImpl(discovery.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("Location") ?? "unknown";
    throw new AuthError(
      `Token refresh redirected unexpectedly to ${location}. Refusing to replay refresh token to another origin.`
    );
  }
  let body;
  try {
    body = await response.json();
  } catch (err) {
    throw new AuthError(
      `Refresh response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
  if (!response.ok) {
    if (response.status === 400 && typeof body === "object" && body !== null && body.error === "invalid_grant") {
      throw new AuthError(
        "Refresh token was refused, rotated, or revoked. Run /login again."
      );
    }
    const description = extractErrorDescription(body) || `${response.status}: ${response.statusText}`;
    throw new AuthError(`Token refresh failed: ${description}`);
  }
  if (typeof body !== "object" || body === null) {
    throw new AuthError("Refresh response is not an object");
  }
  const record = body;
  if (typeof record.access_token !== "string" || !record.access_token) {
    throw new AuthError("Refresh response missing access_token");
  }
  return {
    accessToken: record.access_token,
    tokenType: typeof record.token_type === "string" ? record.token_type : "Bearer",
    expiresIn: typeof record.expires_in === "number" && Number.isFinite(record.expires_in) ? record.expires_in : 3600,
    refreshToken: typeof record.refresh_token === "string" && record.refresh_token ? record.refresh_token : null,
    userId: typeof record.user_id === "string" && record.user_id ? record.user_id : void 0,
    teamId: typeof record.team_id === "string" && record.team_id ? record.team_id : void 0
  };
}
async function revokeToken(discovery, input, timeoutMs, fetchImpl = globalThis.fetch) {
  const params = new URLSearchParams();
  params.set("token", input.token);
  params.set("client_id", input.clientId);
  const response = await fetchImpl(discovery.revocationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("Location") ?? "unknown";
    throw new AuthError(
      `Revocation endpoint redirected unexpectedly to ${location}. Refusing to send token to another origin.`
    );
  }
  if (response.ok) {
    return true;
  }
  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const description = extractErrorDescription(body) || `${response.status}: ${response.statusText}`;
  throw new AuthError(`Token revocation failed: ${description}`);
}
async function fetchModels(baseUrl, apiKey, timeoutMs, fetchImpl = globalThis.fetch) {
  const normalized = baseUrl.replace(/\/+$/, "");
  const response = await fetchImpl(`${normalized}/v1/models?include_metadata=true`, {
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (response.status === 401 || response.status === 403) {
    throw new AuthError(
      "Credential rejected by gateway. Run /login again."
    );
  }
  if (!response.ok) {
    throw new CatalogError(
      `Failed to fetch models: ${response.status}: ${response.statusText}`
    );
  }
  let body;
  try {
    body = await response.json();
  } catch (err) {
    throw new CatalogError(
      `Models response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
  return { baseUrl: normalized, body };
}
async function fetchModelInfoV2(baseUrl, apiKey, timeoutMs, page, size, fetchImpl = globalThis.fetch) {
  const normalized = baseUrl.replace(/\/+$/, "");
  const params = new URLSearchParams();
  params.set("size", String(size));
  params.set("page", String(page));
  const response = await fetchImpl(`${normalized}/v2/model/info?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (response.status === 401 || response.status === 403) {
    throw new AuthError(
      "Credential rejected by gateway. Run /login again."
    );
  }
  if (!response.ok) {
    throw new CatalogError(
      `Failed to fetch model info (v2 page ${page}): ${response.status}: ${response.statusText}`
    );
  }
  let body;
  try {
    body = await response.json();
  } catch (err) {
    throw new CatalogError(
      `Model info (v2 page ${page}) response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
  return { baseUrl: normalized, body };
}
async function fetchModelInfo(baseUrl, apiKey, timeoutMs, fetchImpl = globalThis.fetch) {
  const normalized = baseUrl.replace(/\/+$/, "");
  const response = await fetchImpl(`${normalized}/v1/model/info`, {
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (response.status === 401 || response.status === 403) {
    throw new AuthError(
      "Credential rejected by gateway. Run /login again."
    );
  }
  if (!response.ok) {
    throw new CatalogError(
      `Failed to fetch model info: ${response.status}: ${response.statusText}`
    );
  }
  let body;
  try {
    body = await response.json();
  } catch (err) {
    throw new CatalogError(
      `Model info response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
  return { baseUrl: normalized, body };
}

// src/oauth.ts
import http from "http";

// src/pkce.ts
import { randomBytes, createHash } from "crypto";
function base64urlEncode(bytes) {
  return bytes.toString("base64url").replace(/=+$/, "");
}
function generatePkce() {
  const verifier = base64urlEncode(randomBytes(32));
  const challenge = base64urlEncode(
    createHash("sha256").update(verifier, "utf8").digest()
  );
  return { verifier, challenge };
}
function randomState() {
  return base64urlEncode(randomBytes(16));
}

// src/state.ts
import path from "path";
import { mkdir, readFile, writeFile, rm } from "fs/promises";
import { renameSync } from "fs";
import os from "os";
var STATE_SCHEMA_VERSION = 1;
var DEFAULT_APP_DIR_NAME = "opencode";
var DEFAULT_PLUGIN_DIR_NAME = "actsis-litellm";
var STATE_FILE_NAME = "state.json";
function defaultPluginDir() {
  const dataHome = process.env.XDG_DATA_HOME ? process.env.XDG_DATA_HOME : path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, DEFAULT_APP_DIR_NAME, DEFAULT_PLUGIN_DIR_NAME);
}
function statePath(dir) {
  return path.join(dir ?? defaultPluginDir(), STATE_FILE_NAME);
}
async function readPluginState(dir) {
  const file = statePath(dir);
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const state = parsed;
    if (state.version !== STATE_SCHEMA_VERSION) {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}
async function writePluginState(state, dir) {
  const file = statePath(dir);
  await mkdir(path.dirname(file), { recursive: true });
  const tmpFile = `${file}.tmp.${process.pid}`;
  try {
    const toWrite = {
      ...state,
      version: STATE_SCHEMA_VERSION
    };
    await writeFile(tmpFile, JSON.stringify(toWrite, null, 2), "utf8");
    renameSync(tmpFile, file);
  } catch (err) {
    try {
      await rm(tmpFile, { force: true });
    } catch {
    }
    throw err;
  }
}
async function updatePluginState(patch, dir) {
  const current = await readPluginState(dir) ?? {
    version: STATE_SCHEMA_VERSION
  };
  const next = {
    ...current,
    ...patch,
    version: STATE_SCHEMA_VERSION,
    savedAt: Date.now()
  };
  await writePluginState(next, dir);
  return next;
}

// src/oauth.ts
var CALLBACK_HTML = "Signed in to LiteLLM. You can close this window and return to the terminal.";
var OVERALL_TIMEOUT_MS = 5 * 60 * 1e3;
var LoopbackCallbackServer = class {
  server = null;
  resolveCallback = null;
  rejectCallback = null;
  pendingCallbackUrl = null;
  timeout = null;
  started = false;
  start() {
    if (this.started) {
      return Promise.reject(new AuthError("Loopback callback server already started"));
    }
    this.started = true;
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        if (!req.url) {
          res.writeHead(400);
          res.end("Bad request");
          return;
        }
        const fullUrl = new URL(req.url, `http://127.0.0.1:${this.addressPort()}`);
        if (fullUrl.pathname !== "/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(CALLBACK_HTML);
        if (this.resolveCallback) {
          this.resolveCallback(fullUrl.toString());
          this.resolveCallback = null;
          this.rejectCallback = null;
        } else {
          this.pendingCallbackUrl = fullUrl.toString();
        }
        this.stop();
      });
      this.server.on("error", (err) => {
        this.started = false;
        if (this.rejectCallback) {
          this.rejectCallback(err);
        } else {
          reject(err);
        }
      });
      this.server.listen({ host: "127.0.0.1", port: 0 }, () => {
        this.timeout = setTimeout(() => {
          this.stop();
          if (this.rejectCallback) {
            this.rejectCallback(
              new AuthError("Login timed out after 5 minutes. Run /login again.")
            );
          }
        }, OVERALL_TIMEOUT_MS);
        resolve({ port: this.addressPort() });
      });
    });
  }
  waitForCallback() {
    return new Promise((resolve, reject) => {
      if (this.pendingCallbackUrl !== null) {
        resolve(this.pendingCallbackUrl);
        this.pendingCallbackUrl = null;
        return;
      }
      this.resolveCallback = resolve;
      this.rejectCallback = reject;
    });
  }
  stop() {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    if (this.server) {
      this.server.close(() => {
      });
      this.server = null;
    }
    this.started = false;
  }
  addressPort() {
    if (!this.server) return 0;
    const addr = this.server.address();
    if (addr && typeof addr === "object") return addr.port;
    return 0;
  }
};
function parseCallbackParams(callbackUrl) {
  const url = new URL(callbackUrl);
  const code = url.searchParams.get("code") ?? void 0;
  const state = url.searchParams.get("state") ?? void 0;
  const error = url.searchParams.get("error") ?? void 0;
  const errorDescription = url.searchParams.get("error_description") ?? void 0;
  return { code, state, error, errorDescription };
}
async function runLoginFlow(config, discovery, notices, fetchImpl = globalThis.fetch) {
  const server = new LoopbackCallbackServer();
  try {
    const { port } = await server.start();
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const { clientId } = await registerClient(
      discovery,
      redirectUri,
      config.requestTimeoutMs,
      fetchImpl
    );
    const { verifier, challenge } = generatePkce();
    const state = randomState();
    const authorizeParams = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: discovery.resource
    });
    const authorizeUrl = `${discovery.authorizationEndpoint}?${authorizeParams.toString()}`;
    const callback = async () => {
      try {
        const callbackUrl = await server.waitForCallback();
        const params = parseCallbackParams(callbackUrl);
        if (params.error) {
          throw new AuthError(
            params.errorDescription ? `Authorization failed: ${params.error} \u2014 ${params.errorDescription}` : `Authorization failed: ${params.error}`
          );
        }
        if (!params.code) {
          throw new AuthError("Authorization response did not include a code");
        }
        if (params.state !== state) {
          throw new AuthError("Authorization state mismatch");
        }
        const tokenResponse = await exchangeAuthorizationCode(
          discovery,
          {
            code: params.code,
            redirectUri,
            clientId,
            codeVerifier: verifier
          },
          config.requestTimeoutMs,
          fetchImpl
        );
        const expires = Date.now() + Math.max(tokenResponse.expiresIn - 300, 60) * 1e3;
        await updatePluginState({
          gatewayUrl: discovery.issuer,
          providerId: void 0,
          authMode: "oauth",
          clientId,
          tokenEndpoint: discovery.tokenEndpoint,
          revocationEndpoint: discovery.revocationEndpoint,
          resource: discovery.resource,
          schemeUpgraded: notices?.schemeUpgraded,
          savedAt: Date.now()
        });
        return {
          type: "success",
          refresh: tokenResponse.refreshToken ?? "",
          access: tokenResponse.accessToken,
          expires,
          userId: tokenResponse.userId,
          teamId: tokenResponse.teamId
        };
      } catch (err) {
        return { type: "failed" };
      } finally {
        server.stop();
      }
    };
    return {
      url: authorizeUrl,
      instructions: "Complete sign-in in your browser; this window continues automatically.",
      method: "auto",
      callback
    };
  } catch (err) {
    server.stop();
    throw err;
  }
}

// src/catalog-cache.ts
import path2 from "path";
import { mkdir as mkdir2, readFile as readFile2, writeFile as writeFile2, rm as rm2 } from "fs/promises";
import { renameSync as renameSync2 } from "fs";
import os2 from "os";
var CACHE_SCHEMA_VERSION = 2;
var DEFAULT_APP_DIR_NAME2 = "opencode";
var DEFAULT_PLUGIN_DIR_NAME2 = "actsis-litellm";
var CACHE_FILE_NAME = "models-cache.json";
function defaultPluginDir2() {
  const dataHome = process.env.XDG_DATA_HOME ? process.env.XDG_DATA_HOME : path2.join(os2.homedir(), ".local", "share");
  return path2.join(dataHome, DEFAULT_APP_DIR_NAME2, DEFAULT_PLUGIN_DIR_NAME2);
}
function cachePath(dir) {
  return path2.join(dir ?? defaultPluginDir2(), CACHE_FILE_NAME);
}
async function loadCachedModels(dir) {
  const file = cachePath(dir);
  try {
    const raw = await readFile2(file, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const fileData = parsed;
    if (fileData.version !== CACHE_SCHEMA_VERSION) {
      return null;
    }
    if (!Number.isFinite(fileData.fetchedAt)) {
      return null;
    }
    if (typeof fileData.models !== "object" || fileData.models === null) {
      return null;
    }
    return fileData.models;
  } catch {
    return null;
  }
}
async function saveCachedModels(models, dir) {
  const file = cachePath(dir);
  await mkdir2(path2.dirname(file), { recursive: true });
  const tmpFile = `${file}.tmp.${process.pid}`;
  const toWrite = {
    version: CACHE_SCHEMA_VERSION,
    fetchedAt: Date.now(),
    models
  };
  try {
    await writeFile2(tmpFile, JSON.stringify(toWrite, null, 2), "utf8");
    renameSync2(tmpFile, file);
  } catch (err) {
    try {
      await rm2(tmpFile, { force: true });
    } catch {
    }
    throw err;
  }
}
async function computeCacheAge(dir) {
  const file = cachePath(dir);
  try {
    const raw = await readFile2(file, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const fileData = parsed;
    if (fileData.version !== CACHE_SCHEMA_VERSION) {
      return null;
    }
    if (!Number.isFinite(fileData.fetchedAt)) {
      return null;
    }
    return Math.max(0, Date.now() - fileData.fetchedAt);
  } catch {
    return null;
  }
}

// src/catalog.ts
var CHAT_MODES = /* @__PURE__ */ new Set(["chat", "completion"]);
var NON_CHAT_MODES = /* @__PURE__ */ new Set([
  "embedding",
  "audio_speech",
  "audio_transcription",
  "image_generation",
  "image_edit",
  "video_generation",
  "rerank",
  "moderations",
  "realtime"
]);
var NON_CHAT_ID_RE = /(^|[-_/.])(embed|embedding|embeddings|whisper|tts|transcription|transcrib|rerank|reranker|moderation|moderations|speech|diarize|dall-e|dalle|imagegen|stable-diffusion)([-_/.]|$)/i;
function isChatModelId(id, metadataMode) {
  if (typeof metadataMode === "string" && metadataMode.length > 0) {
    const mode = metadataMode.toLowerCase();
    if (CHAT_MODES.has(mode)) return true;
    if (NON_CHAT_MODES.has(mode)) return false;
  }
  return !NON_CHAT_ID_RE.test(id);
}
function extractMode(entry) {
  if (!entry || typeof entry !== "object") return void 0;
  const resolved = resolveModelInfo(entry);
  const mode = resolved.mode;
  if (typeof mode === "string" && mode) return mode;
  const litellmParams = resolved.litellm_params;
  if (litellmParams && typeof litellmParams === "object") {
    const lpMode = litellmParams.mode;
    if (typeof lpMode === "string" && lpMode) return lpMode;
  }
  const metadata = resolved.metadata;
  if (metadata && typeof metadata === "object") {
    const mdMode = metadata.mode;
    if (typeof mdMode === "string" && mdMode) return mdMode;
  }
  return void 0;
}
function resolveModelInfo(entry) {
  if (!entry) return {};
  const nested = entry.model_info;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return { ...entry, ...nested };
  }
  return entry;
}
function infoMapKey(entry) {
  if (typeof entry.model_name === "string" && entry.model_name) {
    return entry.model_name;
  }
  const nested = resolveModelInfo(entry);
  if (typeof nested.key === "string" && nested.key) {
    return nested.key;
  }
  return typeof entry.id === "string" && entry.id ? entry.id : "";
}
var V2_PAGE_SIZE = 100;
var V2_MAX_PAGES = 5;
var TIER_SUFFIXES = [
  [128e3, "128k"],
  [2e5, "200k"],
  [272e3, "272k"],
  [512e3, "512k"]
];
function perMillion(value) {
  if (value === void 0 || value === null || !Number.isFinite(value)) return 0;
  return value * 1e6;
}
function positiveInt(value) {
  if (typeof value !== "number") return void 0;
  if (!Number.isFinite(value) || value <= 0) return void 0;
  return Math.floor(value);
}
function buildEffortVariants(levels) {
  if (!Array.isArray(levels)) return void 0;
  const variants = {};
  for (const level of levels) {
    if (typeof level !== "string" || !level) continue;
    variants[level] = { reasoningEffort: level };
  }
  return Object.keys(variants).length > 0 ? variants : void 0;
}
function buildInfoMap(infoBody) {
  const map = /* @__PURE__ */ new Map();
  const entries = Array.isArray(infoBody) ? infoBody : infoBody !== null && typeof infoBody === "object" && Array.isArray(infoBody.data) ? infoBody.data : [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const info = entry;
    const id = infoMapKey(info);
    if (!id) continue;
    if (!map.has(id)) {
      map.set(id, info);
    }
  }
  return map;
}
function buildCostTiers(resolved) {
  const cacheRead = perMillion(resolved.cache_read_input_token_cost);
  const cacheWrite = perMillion(resolved.cache_creation_input_token_cost);
  const tiers = [];
  for (const [size, suffix] of TIER_SUFFIXES) {
    const rawInput = resolved[`input_cost_per_token_above_${suffix}_tokens`];
    const rawOutput = resolved[`output_cost_per_token_above_${suffix}_tokens`];
    const input = typeof rawInput === "number" && Number.isFinite(rawInput) ? rawInput : void 0;
    const output = typeof rawOutput === "number" && Number.isFinite(rawOutput) ? rawOutput : void 0;
    if (input === void 0 && output === void 0) continue;
    tiers.push({
      input: input !== void 0 ? input * 1e6 : 0,
      output: output !== void 0 ? output * 1e6 : 0,
      cache: { read: cacheRead, write: cacheWrite },
      tier: { type: "context", size }
    });
  }
  tiers.sort((a, b) => a.tier.size - b.tier.size);
  return tiers;
}
function infoToConfig(id, info) {
  const resolved = resolveModelInfo(info);
  const contextWindow = positiveInt(resolved.max_input_tokens) ?? 128e3;
  const maxTokens = positiveInt(resolved.max_output_tokens) ?? 16384;
  const input = ["text"];
  if (resolved.supports_vision === true) input.push("image");
  const variants = buildEffortVariants(resolved.reasoning_effort_levels);
  const tiers = buildCostTiers(resolved);
  return {
    name: id,
    tool_call: resolved.supports_function_calling !== false,
    reasoning: variants !== void 0 || resolved.supports_reasoning !== false,
    limit: {
      context: contextWindow,
      output: maxTokens
    },
    modalities: {
      input,
      output: ["text"]
    },
    cost: {
      input: perMillion(resolved.input_cost_per_token),
      output: perMillion(resolved.output_cost_per_token),
      cache_read: perMillion(resolved.cache_read_input_token_cost),
      cache_write: perMillion(resolved.cache_creation_input_token_cost),
      ...tiers.length > 0 ? { tiers } : {}
    },
    ...variants ? { variants } : {}
  };
}
function mapCatalogModels(modelsBody, infoBody) {
  if (!Array.isArray(modelsBody?.data)) {
    throw new CatalogError(
      "Gateway /v1/models response did not contain a data array"
    );
  }
  const infoMap = buildInfoMap(infoBody);
  const seen = /* @__PURE__ */ new Set();
  const models = [];
  for (const entry of modelsBody.data) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = typeof entry.id === "string" ? entry.id : "";
    if (!id || seen.has(id)) continue;
    const infoEntry = infoMap.get(id);
    const mode = extractMode(entry) ?? extractMode(infoEntry);
    if (!isChatModelId(id, mode)) continue;
    seen.add(id);
    models.push(infoToConfig(id, infoEntry));
  }
  models.sort((a, b) => a.name.localeCompare(b.name));
  return models;
}
async function fetchCatalogModels(config, apiKey, signal, fetchImpl = globalThis.fetch) {
  const modelsResult = await fetchModels(
    config.baseUrl,
    apiKey,
    config.requestTimeoutMs,
    fetchImpl
  );
  let infoMap = /* @__PURE__ */ new Map();
  try {
    const infoResult = await fetchModelInfo(
      config.baseUrl,
      apiKey,
      config.requestTimeoutMs,
      fetchImpl
    );
    infoMap = buildInfoMap(infoResult.body);
  } catch {
  }
  if (infoMap.size === 0) {
    try {
      const first = await fetchModelInfoV2(
        config.baseUrl,
        apiKey,
        config.requestTimeoutMs,
        1,
        V2_PAGE_SIZE,
        fetchImpl
      );
      const firstBody = first.body !== null && typeof first.body === "object" ? first.body : null;
      if (firstBody) {
        const map = buildInfoMap(firstBody.data);
        for (const [key, value] of map) infoMap.set(key, value);
        const totalPages = positiveInt(firstBody.total_pages) ?? 1;
        const lastPage = Math.min(totalPages, V2_MAX_PAGES);
        for (let page = 2; page <= lastPage; page++) {
          const result = await fetchModelInfoV2(
            config.baseUrl,
            apiKey,
            config.requestTimeoutMs,
            page,
            V2_PAGE_SIZE,
            fetchImpl
          );
          const pageMap = buildInfoMap(
            result.body?.data
          );
          for (const [key, value] of pageMap) infoMap.set(key, value);
        }
      }
    } catch {
    }
  }
  return mapCatalogModels(modelsResult.body, [
    ...infoMap.values()
  ]);
}

// src/budget.ts
function parseBudgetResetAt(value) {
  if (value === void 0 || value === null) return null;
  if (typeof value === "number") {
    if (value < 1e12) {
      return value * 1e3;
    }
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}
function asNullableNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}
function asNullableString(value) {
  return typeof value === "string" && value ? value : null;
}
function asRecord(value) {
  return typeof value === "object" && value !== null ? value : {};
}
function parseBudgetRecord(record) {
  return {
    spend: asNullableNumber(record.spend),
    maxBudget: asNullableNumber(record.max_budget),
    tpmLimit: asNullableNumber(record.tpm_limit),
    rpmLimit: asNullableNumber(record.rpm_limit),
    budgetResetAt: parseBudgetResetAt(record.budget_reset_at),
    keyAlias: asNullableString(record.key_alias)
  };
}
async function requestJson(url, apiKey, timeoutMs, fetchImpl, label) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    throw new CatalogError(
      `Failed to fetch ${label}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new AuthError("Credential rejected by gateway. Run /login again.");
  }
  if (!response.ok) {
    throw new CatalogError(
      `Failed to fetch ${label}: ${response.status}: ${response.statusText}`
    );
  }
  try {
    return await response.json();
  } catch (err) {
    throw new CatalogError(
      `${label} response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
}
async function fetchBudgetInfo(baseUrl, apiKey, timeoutMs, fetchImpl = globalThis.fetch) {
  const normalized = baseUrl.replace(/\/+$/, "");
  const body = await requestJson(
    `${normalized}/key/info`,
    apiKey,
    timeoutMs,
    fetchImpl,
    "budget info"
  );
  const record = asRecord(body);
  const target = record.info ? record.info : record;
  return parseBudgetRecord(target);
}
async function fetchUserBudget(baseUrl, apiKey, timeoutMs, fetchImpl) {
  const normalized = baseUrl.replace(/\/+$/, "");
  const body = await requestJson(
    `${normalized}/user/info`,
    apiKey,
    timeoutMs,
    fetchImpl,
    "user info"
  );
  const record = asRecord(body);
  const target = record.user_info ? record.user_info : record;
  return {
    budget: parseBudgetRecord(target),
    userId: asNullableString(record.user_id),
    userAlias: asNullableString(target.key_alias) ?? asNullableString(record.user_alias)
  };
}
async function fetchOwnKeyBudgets(baseUrl, apiKey, timeoutMs, fetchImpl, filter) {
  if (!filter.userId && !filter.userAlias) {
    return [];
  }
  const normalized = baseUrl.replace(/\/+$/, "");
  const body = await requestJson(
    `${normalized}/spend/keys`,
    apiKey,
    timeoutMs,
    fetchImpl,
    "spend keys"
  );
  if (!Array.isArray(body)) {
    throw new CatalogError("Spend keys response is not an array");
  }
  return body.map(asRecord).filter((entry) => {
    if (filter.userId) {
      return entry.user_id === filter.userId;
    }
    return entry.key_alias === filter.userAlias;
  }).map((entry) => parseBudgetRecord(entry));
}
async function fetchGatewayBudget(baseUrl, apiKey, timeoutMs, fetchImpl = globalThis.fetch) {
  try {
    const keyBudget = await fetchBudgetInfo(baseUrl, apiKey, timeoutMs, fetchImpl);
    return { primary: keyBudget, ownKeys: [keyBudget], source: "key_info" };
  } catch (err) {
    if (err instanceof AuthError) {
      throw err;
    }
  }
  const userBudget = await fetchUserBudget(baseUrl, apiKey, timeoutMs, fetchImpl);
  let ownKeys = [];
  try {
    ownKeys = await fetchOwnKeyBudgets(baseUrl, apiKey, timeoutMs, fetchImpl, {
      userId: userBudget.userId,
      userAlias: userBudget.userAlias
    });
  } catch {
  }
  return { primary: userBudget.budget, ownKeys, source: "user_info" };
}
function budgetUsagePercent(spend, maxBudget) {
  if (maxBudget === null || maxBudget <= 0) return 0;
  return (spend ?? 0) / maxBudget * 100;
}
var GAUGE_CELLS = 8;
var GAUGE_FILLED = "\u25B0";
var GAUGE_EMPTY = "\u25B1";
function budgetGauge(percent) {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round(clamped / 100 * GAUGE_CELLS);
  return GAUGE_FILLED.repeat(filled) + GAUGE_EMPTY.repeat(GAUGE_CELLS - filled);
}
function formatBudgetStatus(info) {
  if (info.spend === null) return void 0;
  const spend = `$${info.spend.toFixed(2)}`;
  if (info.maxBudget !== null && info.maxBudget > 0) {
    const percent = budgetUsagePercent(info.spend, info.maxBudget);
    const cap = `$${info.maxBudget.toFixed(2)}`;
    return `Budget ${budgetGauge(percent)} ${Math.round(percent)}% \xB7 ${spend}/${cap}`;
  }
  return `Budget ${spend} used (no cap)`;
}
function formatBudgetLine(info) {
  if (info.spend === null) return null;
  const percent = budgetUsagePercent(info.spend, info.maxBudget);
  const capPart = info.maxBudget !== null ? ` / $${info.maxBudget.toFixed(2)} used (${Math.round(percent)}%)` : ` used (no budget cap)`;
  let line = `$${info.spend.toFixed(2)}${capPart}`;
  if (info.tpmLimit !== null) {
    line += ` | TPM ${info.tpmLimit.toLocaleString("en-US")}`;
  }
  if (info.rpmLimit !== null) {
    line += ` | RPM ${info.rpmLimit.toLocaleString("en-US")}`;
  }
  if (info.budgetResetAt !== null) {
    const time = new Date(info.budgetResetAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    });
    line += ` | resets ${time}`;
  }
  return line;
}

// src/limit-errors.ts
function extractFirstBalancedJson(text) {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      if (depth === 0) {
        start = i;
      }
      depth++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0 && start !== -1) {
        return text.slice(start, i + 1);
      }
      continue;
    }
  }
  return null;
}
function looksLikeRateLimit429(text) {
  if (text.includes("429")) return true;
  const lower = text.toLowerCase();
  return lower.includes("rate limit") || lower.includes("too many requests") || lower.includes("throttl");
}
function parseNumberish(value) {
  if (!value) return void 0;
  const trimmed = value.trim();
  if (trimmed === "") return void 0;
  const parsed = Number(trimmed);
  if (Number.isNaN(parsed) || !Number.isFinite(parsed)) return void 0;
  return parsed;
}
function extractBudgetNumbers(message) {
  if (!message) return {};
  const currentMatch = message.match(/Current cost:\s*([0-9]+(?:\.[0-9]+)?)/i);
  const maxMatch = message.match(/Max budget:\s*([0-9]+(?:\.[0-9]+)?)/i);
  return {
    currentSpend: parseNumberish(currentMatch?.[1]),
    maxBudget: parseNumberish(maxMatch?.[1])
  };
}
function extractThrottleInfo(message) {
  if (!message) return {};
  const limitTypeMatch = message.match(/Limit type:\s*([^,.]+)/i);
  const resetMatch = message.match(
    /Limit resets at:\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s*UTC/i
  );
  const limitType = limitTypeMatch?.[1]?.trim();
  const resetText = resetMatch?.[1];
  let resetsAt;
  if (resetText) {
    const parsed = Date.parse(`${resetText} UTC`);
    if (!Number.isNaN(parsed)) resetsAt = parsed;
  }
  return {
    limitType: limitType || void 0,
    resetsAt
  };
}
function parseLimitError(message) {
  if (!message) return null;
  const jsonText = extractFirstBalancedJson(message);
  if (!jsonText) {
    return looksLikeRateLimit429(message) ? { kind: "rate_limit_other", raw: message } : null;
  }
  let payload;
  try {
    payload = JSON.parse(jsonText);
  } catch {
    return looksLikeRateLimit429(message) ? { kind: "rate_limit_other", raw: message } : null;
  }
  const kindByType = (payload.type ?? "").toLowerCase();
  if (kindByType === "budget_exceeded") {
    return {
      kind: "budget_exceeded",
      ...extractBudgetNumbers(payload.message),
      raw: message
    };
  }
  if (kindByType === "throttling_error") {
    return {
      kind: "throttling_error",
      ...extractThrottleInfo(payload.message),
      raw: message
    };
  }
  const is429 = String(payload.code ?? "").includes("429") || message.includes("429");
  if (!is429) return null;
  return { kind: "rate_limit_other", raw: message };
}
function formatBudgetWarning(info) {
  const spend = info.currentSpend ?? 0;
  const max = info.maxBudget ?? 0;
  return `Budget exceeded: $${spend.toFixed(2)} of $${max.toFixed(2)} used \u2014 top up the key budget or wait for the reset.`;
}
function formatThrottleWarning(info) {
  const limitType = info.limitType ? `(${info.limitType})` : "";
  const prefix = limitType ? `Rate limit reached ${limitType}` : "Rate limit reached";
  if (info.resetsAt) {
    const resetsLocal = new Date(info.resetsAt);
    const now = Date.now();
    const minutes = Math.max(0, Math.ceil((info.resetsAt - now) / 6e4));
    const time = resetsLocal.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    });
    return `${prefix}. Resets at ${time} (~${minutes} min). OpenCode will retry automatically.`;
  }
  return `${prefix}. OpenCode will retry automatically.`;
}

// src/overflow.ts
var LITELLM_OVERFLOW_PATTERN = new RegExp(
  [
    "maximum context length",
    "context window",
    "context_length_exceeded",
    "input is too long",
    "prompt is too long",
    "too many input tokens",
    "requested tokens exceed",
    "reduce the length"
  ].join("|"),
  "i"
);
function isOverflowErrorMessage(message) {
  if (!message) return false;
  return LITELLM_OVERFLOW_PATTERN.test(message);
}

// src/auth-store.ts
import { access, readFile as readFile3, writeFile as writeFile3 } from "fs/promises";
import os3 from "os";
import path3 from "path";
function defaultAuthPath() {
  const dataHome = process.env.XDG_DATA_HOME ? process.env.XDG_DATA_HOME : path3.join(os3.homedir(), ".local", "share");
  return path3.join(dataHome, "opencode", "auth.json");
}
async function readAuthEntry(authPath = defaultAuthPath(), providerId) {
  let raw;
  try {
    raw = await readFile3(authPath, "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed;
  const entry = record[providerId];
  if (typeof entry !== "object" || entry === null) {
    return null;
  }
  const typed = entry;
  if (typed.type === "oauth") {
    const oauth = entry;
    if (typeof oauth.access === "string" && typeof oauth.refresh === "string" && typeof oauth.expires === "number") {
      return oauth;
    }
  }
  if (typed.type === "api") {
    const api = entry;
    if (typeof api.key === "string") {
      return api;
    }
  }
  return null;
}
async function clearAuthEntry(authPath = defaultAuthPath(), providerId) {
  try {
    await access(authPath);
  } catch {
    return;
  }
  let parsed;
  try {
    const raw = await readFile3(authPath, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return;
  }
  const record = parsed;
  if (!Object.prototype.hasOwnProperty.call(record, providerId)) {
    return;
  }
  delete record[providerId];
  await writeFile3(authPath, JSON.stringify(record, null, 2), {
    encoding: "utf8",
    mode: 384
  });
}

// src/config.ts
var DEFAULT_CATALOG_TTL_MS = 15 * 60 * 1e3;
function normalizeBaseUrl(raw) {
  const trimmed = raw.trim();
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ConfigError(
      `Invalid gateway URL: ${raw}. It must be an http:// or https:// URL.`
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(
      `Invalid gateway URL: ${raw}. Only http:// and https:// are supported.`
    );
  }
  let normalized = `${url.protocol}//${url.host}${url.pathname}`;
  normalized = normalized.replace(/\/+$/, "");
  normalized = normalized.replace(/\/v1$/, "");
  return normalized;
}

// src/gateway-client.ts
var REFRESH_WINDOW_MS = 3e5;
function discoveryFromState(state) {
  return {
    contractVersion: 1,
    issuer: state.tokenEndpoint ? new URL(state.tokenEndpoint).origin : "",
    authorizationEndpoint: state.tokenEndpoint ?? "",
    tokenEndpoint: state.tokenEndpoint ?? "",
    registrationEndpoint: state.tokenEndpoint ?? "",
    revocationEndpoint: state.revocationEndpoint ?? "",
    resource: state.resource ?? "",
    codeChallengeMethods: ["S256"],
    grantTypes: ["authorization_code", "refresh_token"],
    tokenEndpointAuthMethods: ["none"]
  };
}
async function ensureFreshToken(credential, context) {
  const expires = typeof credential.expires === "number" ? credential.expires : null;
  const refresh = typeof credential.refresh === "string" && credential.refresh ? credential.refresh : null;
  if (expires !== null && expires < Date.now() + REFRESH_WINDOW_MS && refresh && context.state?.tokenEndpoint) {
    const refreshed = await refreshGrant(
      discoveryFromState(context.state),
      { refreshToken: refresh, clientId: context.state.clientId ?? "" },
      context.timeoutMs,
      context.fetchImpl
    );
    const next = {
      access: refreshed.accessToken,
      refresh: refreshed.refreshToken ?? refresh,
      expires: Date.now() + Math.max(refreshed.expiresIn - 300, 60) * 1e3
    };
    if (context.onRefreshed) {
      await context.onRefreshed(next);
    }
    return next.access;
  }
  return credential.access;
}

// src/plugin.ts
var DEFAULT_PROVIDER_ID = "actsis-litellm";
var DEFAULT_CATALOG_TTL_MS2 = 15 * 60 * 1e3;
var DEFAULT_REQUEST_TIMEOUT_MS = 3e4;
function normalizeOptions(options) {
  if (!options || typeof options !== "object") {
    return {};
  }
  const record = options;
  return {
    url: typeof record.url === "string" ? record.url : void 0,
    providerId: typeof record.providerId === "string" ? record.providerId : void 0,
    catalogTtlMinutes: typeof record.catalogTtlMinutes === "number" ? record.catalogTtlMinutes : void 0,
    requestTimeoutMs: typeof record.requestTimeoutMs === "number" ? record.requestTimeoutMs : void 0
  };
}
function resolveProviderId(options) {
  const id = options?.providerId?.trim();
  return id || DEFAULT_PROVIDER_ID;
}
async function resolveClosure(input, options, authPath = defaultAuthPath(), stateDir) {
  const pluginOptions = normalizeOptions(options);
  const providerId = resolveProviderId(pluginOptions);
  const envUrl = process.env.ACTSIS_LITELLM_URL?.trim();
  const storedUrl = (await readPluginState(stateDir))?.gatewayUrl;
  let baseUrl = null;
  if (envUrl) {
    baseUrl = normalizeBaseUrl(envUrl);
  } else if (pluginOptions.url) {
    baseUrl = normalizeBaseUrl(pluginOptions.url);
  } else if (storedUrl) {
    baseUrl = normalizeBaseUrl(storedUrl);
  }
  const catalogTtlMs = pluginOptions.catalogTtlMinutes !== void 0 ? Math.max(0, pluginOptions.catalogTtlMinutes * 60 * 1e3) : DEFAULT_CATALOG_TTL_MS2;
  const requestTimeoutMs = pluginOptions.requestTimeoutMs !== void 0 ? pluginOptions.requestTimeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;
  return {
    baseUrl,
    providerId,
    catalogTtlMs,
    requestTimeoutMs,
    authPath,
    stateDir
  };
}
function buildProviderInjection(config, params) {
  const existing = config.provider?.[params.providerId];
  const baseURL = params.baseUrl ? `${params.baseUrl}/v1` : "";
  const merged = {
    npm: existing?.npm ?? "@ai-sdk/openai-compatible",
    name: existing?.name ?? "Actsis LiteLLM",
    options: {
      baseURL,
      apiKey: "",
      ...existing?.options
    },
    models: {
      ...existing?.models ?? {},
      ...params.models
    }
  };
  if (!config.provider) {
    config.provider = {};
  }
  config.provider[params.providerId] = merged;
}
function buildCommandTemplates(existing) {
  const commands = {};
  if (!existing?.["actsis-litellm-status"]) {
    commands["actsis-litellm-status"] = {
      template: "Use the actsis_litellm_status tool, then summarize its result for the user.",
      description: "Show LiteLLM gateway status and model cache state."
    };
  }
  if (!existing?.["actsis-litellm-models"]) {
    commands["actsis-litellm-models"] = {
      template: "Use the actsis_litellm_models tool, then summarize its result for the user.",
      description: "Force-sync the LiteLLM model catalog and show changes."
    };
  }
  if (!existing?.["actsis-litellm-budget"]) {
    commands["actsis-litellm-budget"] = {
      template: "Use the actsis_litellm_budget tool, then summarize its result for the user.",
      description: "Force a budget refresh and report the exact outcome."
    };
  }
  if (!existing?.["actsis-litellm-logout"]) {
    commands["actsis-litellm-logout"] = {
      template: "Use the actsis_litellm_logout tool, then summarize its result for the user.",
      description: "Revoke LiteLLM credentials and clear local state."
    };
  }
  return commands;
}
async function resolveGatewayUrlForAuth(inputs, closure) {
  const fromInput = inputs?.gatewayUrl?.trim();
  if (fromInput) {
    return normalizeBaseUrl(fromInput);
  }
  if (closure.baseUrl) {
    return closure.baseUrl;
  }
  throw new ConfigError("Gateway URL not configured. Provide it during login or set ACTSIS_LITELLM_URL / plugin options.");
}
function makeGatewayUrlPrompt(closure) {
  return {
    type: "text",
    key: "gatewayUrl",
    message: "Gateway base URL (press Enter to use the configured one)",
    placeholder: "https://your-gateway.example.com",
    validate(value) {
      const trimmed = value.trim();
      if (!trimmed) {
        if (closure.baseUrl) return void 0;
        return "Gateway URL is required.";
      }
      try {
        const url = new URL(trimmed);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          return "Gateway URL must use http:// or https://.";
        }
      } catch {
        return "Gateway URL is not a valid URL.";
      }
      return void 0;
    }
  };
}
function buildOAuthMethod(closure) {
  return {
    type: "oauth",
    label: "Sign in with SSO (browser)",
    prompts: [makeGatewayUrlPrompt(closure)],
    async authorize(inputs) {
      const baseUrl = await resolveGatewayUrlForAuth(inputs, closure);
      let schemeUpgraded = false;
      const discovery = await fetchCliAuthDiscovery(
        baseUrl,
        closure.requestTimeoutMs,
        () => {
          schemeUpgraded = true;
        }
      );
      const flow = await runLoginFlow(
        { requestTimeoutMs: closure.requestTimeoutMs },
        discovery,
        { schemeUpgraded }
      );
      const originalCallback = flow.callback;
      const wrappedCallback = async () => {
        try {
          const result = await originalCallback();
          if (result.type === "success") {
            await updatePluginState(
              {
                gatewayUrl: baseUrl,
                providerId: closure.providerId,
                authMode: "oauth",
                clientId: discovery.issuer,
                tokenEndpoint: discovery.tokenEndpoint,
                revocationEndpoint: discovery.revocationEndpoint,
                resource: discovery.resource,
                schemeUpgraded
              },
              closure.stateDir
            );
          }
          return result;
        } catch {
          return { type: "failed" };
        }
      };
      return {
        ...flow,
        callback: wrappedCallback
      };
    }
  };
}
function buildApiKeyMethod(closure) {
  return {
    type: "api",
    label: "Use an API key",
    prompts: [makeGatewayUrlPrompt(closure)],
    async authorize(inputs) {
      try {
        const baseUrl = await resolveGatewayUrlForAuth(inputs, closure);
        await updatePluginState(
          {
            gatewayUrl: baseUrl,
            providerId: closure.providerId,
            authMode: "api_key",
            clientId: void 0,
            tokenEndpoint: void 0,
            revocationEndpoint: void 0,
            resource: void 0
          },
          closure.stateDir
        );
        return { type: "success" };
      } catch {
        return { type: "failed" };
      }
    }
  };
}
function makeAuthFetch(getToken, fetchImpl = globalThis.fetch) {
  return async (input, init) => {
    const token = await getToken();
    const headers = new Headers(init?.headers);
    headers.delete("x-api-key");
    headers.delete("authorization");
    headers.delete("Authorization");
    headers.set("Authorization", `Bearer ${token}`);
    const response = await fetchImpl(input, { ...init, headers });
    if (!response.ok) {
      const text = await response.clone().text().catch(() => "");
      const lower = text.toLowerCase();
      if (isOverflowErrorMessage(text)) {
        throw new Error(`context_length_exceeded: ${text.slice(0, 300)}`);
      }
      const info = parseLimitError(text);
      if (info) {
        if (info.kind === "budget_exceeded") {
          throw new Error(formatBudgetWarning(info));
        }
        if (info.kind === "throttling_error") {
          throw new Error(`${text.trim()} | ${formatThrottleWarning(info)}`);
        }
      }
      return response;
    }
    return response;
  };
}
function buildAuthLoader(closure, input) {
  return async function authLoader(getAuth) {
    const state = await readPluginState(closure.stateDir);
    const baseUrl = closure.baseUrl ?? (state?.gatewayUrl && closure.providerId === state.providerId ? normalizeBaseUrl(state.gatewayUrl) : null);
    const baseURL = baseUrl ? `${baseUrl}/v1` : "";
    let current;
    try {
      current = await getAuth();
    } catch {
      return {};
    }
    if (current.type === "api") {
      return {
        apiKey: current.key,
        baseURL,
        fetch: makeAuthFetch(() => Promise.resolve(current.key))
      };
    }
    if (current.type === "oauth") {
      const tokenProvider = async () => {
        const cur = await getAuth();
        if (cur.type !== "oauth") {
          throw new Error("Not signed in to the LiteLLM gateway \u2014 run /login");
        }
        return ensureFreshToken(
          { access: cur.access, refresh: cur.refresh, expires: cur.expires },
          {
            state: await readPluginState(closure.stateDir),
            timeoutMs: closure.requestTimeoutMs,
            onRefreshed: async (next) => {
              await input.client.auth.set({
                path: { id: closure.providerId },
                body: { type: "oauth", ...next }
              });
            }
          }
        );
      };
      return {
        apiKey: "",
        baseURL,
        fetch: makeAuthFetch(tokenProvider)
      };
    }
    return {};
  };
}
function buildProviderModels(closure) {
  return async function providerModels(_provider, ctx) {
    let token;
    if (ctx.auth?.type === "oauth") {
      token = ctx.auth.access;
    } else if (ctx.auth?.type === "api") {
      token = ctx.auth.key;
    }
    const state = await readPluginState(closure.stateDir);
    const baseUrl = closure.baseUrl ?? (state?.gatewayUrl ? normalizeBaseUrl(state.gatewayUrl) : null);
    const cached = await loadCachedModels(closure.stateDir);
    if (cached && Object.keys(cached).length > 0) {
      const age = await computeCacheAge(closure.stateDir);
      if (age !== null && age < closure.catalogTtlMs) {
        return cached;
      }
    }
    if (!token || !baseUrl) {
      return cached ?? {};
    }
    try {
      const fresh = await fetchCatalogModels(
        {
          baseUrl,
          providerId: closure.providerId,
          catalogTtlMs: closure.catalogTtlMs,
          requestTimeoutMs: closure.requestTimeoutMs
        },
        token
      );
      const record = {};
      for (const model of fresh) {
        record[model.name] = model;
      }
      await saveCachedModels(record, closure.stateDir);
      return record;
    } catch {
      return cached ?? {};
    }
  };
}
async function ActsisActiveLLMPlugin(input, options) {
  const closure = await resolveClosure(
    input,
    options,
    defaultAuthPath(),
    process.env.ACTSIS_LITELLM_STATE_DIR
  );
  const hooks = {
    config: void 0,
    auth: void 0,
    provider: void 0,
    tool: void 0,
    "chat.headers": void 0,
    "chat.params": void 0,
    event: void 0
  };
  hooks.config = async (config) => {
    const token = readAuthEntry(closure.authPath, closure.providerId)?.then((entry) => {
      if (entry?.type === "oauth") return entry.access;
      if (entry?.type === "api") return entry.key;
      return void 0;
    });
    let models = {};
    const resolvedToken = await token;
    const cacheAge = await computeCacheAge(closure.stateDir);
    const cacheFresh = cacheAge !== null && cacheAge < closure.catalogTtlMs;
    if (resolvedToken && closure.baseUrl && (!cacheFresh || Object.keys(models).length === 0)) {
      try {
        const fresh = await fetchCatalogModels(
          {
            baseUrl: closure.baseUrl,
            providerId: closure.providerId,
            catalogTtlMs: closure.catalogTtlMs,
            requestTimeoutMs: closure.requestTimeoutMs
          },
          resolvedToken
        );
        for (const model of fresh) {
          models[model.name] = model;
        }
        await saveCachedModels(models, closure.stateDir);
      } catch {
        const cached = await loadCachedModels(closure.stateDir);
        if (cached) {
          models = cached;
        }
      }
    } else {
      const cached = await loadCachedModels(closure.stateDir);
      if (cached) {
        models = cached;
      }
    }
    buildProviderInjection(config, {
      providerId: closure.providerId,
      baseUrl: closure.baseUrl,
      models
    });
    const commands = buildCommandTemplates(config.command);
    if (!config.command) {
      config.command = {};
    }
    Object.assign(config.command, commands);
  };
  hooks.auth = {
    provider: closure.providerId,
    loader: buildAuthLoader(closure, input),
    methods: [buildOAuthMethod(closure), buildApiKeyMethod(closure)]
  };
  hooks.provider = {
    id: closure.providerId,
    models: buildProviderModels(closure)
  };
  hooks.tool = {};
  hooks["chat.headers"] = async (hookInput, output) => {
    if (hookInput.model?.providerID === closure.providerId && hookInput.sessionID) {
      output.headers["X-Litellm-Session-ID"] = hookInput.sessionID;
    }
  };
  hooks["chat.params"] = async (hookInput, output) => {
    if (hookInput.model?.providerID !== closure.providerId) {
      return;
    }
    const thinking = output.options.thinking;
    if (typeof thinking === "string") {
      if (thinking.toLowerCase() === "off" || thinking.toLowerCase() === "disabled") {
        output.options.thinking = { type: "disabled" };
      } else {
        output.options.thinking = { type: "adaptive" };
      }
    } else if (typeof thinking === "object" && thinking !== null) {
      const type = thinking.type;
      if (type !== "disabled" && type !== "adaptive") {
        output.options.thinking = { type: "adaptive" };
      }
    }
  };
  hooks.event = async ({ event }) => {
    if (event.type !== "session.idle") return;
    try {
      const state = await readPluginState(closure.stateDir);
      const entry = await readAuthEntry(closure.authPath, closure.providerId);
      if (!state?.gatewayUrl || !entry) return;
      const token = entry.type === "oauth" ? await ensureFreshToken(
        { access: entry.access, refresh: entry.refresh, expires: entry.expires },
        {
          state,
          timeoutMs: closure.requestTimeoutMs,
          onRefreshed: async (next) => {
            await input.client.auth.set({
              path: { id: closure.providerId },
              body: { type: "oauth", ...next }
            });
          }
        }
      ) : entry.key;
      const snapshot = await fetchGatewayBudget(state.gatewayUrl, token, closure.requestTimeoutMs);
      await updatePluginState(
        { lastBudgetSnapshot: snapshot, budgetRefreshedAt: Date.now() },
        closure.stateDir
      );
    } catch {
    }
  };
  return hooks;
}

// src/tools.ts
import { tool } from "@opencode-ai/plugin";
import path4 from "path";
import os4 from "os";
import { rm as rm3 } from "fs/promises";
var DEFAULT_PLUGIN_DIR_NAME3 = "actsis-litellm";
var DEFAULT_APP_DIR_NAME3 = "opencode";
var CACHE_FILE_NAME2 = "models-cache.json";
function defaultPluginDir3() {
  const dataHome = process.env.XDG_DATA_HOME ? process.env.XDG_DATA_HOME : path4.join(os4.homedir(), ".local", "share");
  return path4.join(dataHome, DEFAULT_APP_DIR_NAME3, DEFAULT_PLUGIN_DIR_NAME3);
}
function cachePath2(dir) {
  return path4.join(dir ?? defaultPluginDir3(), CACHE_FILE_NAME2);
}
function formatExpiry(entry) {
  if (!entry) return "never";
  if (entry.type === "api") return "never";
  if (!Number.isFinite(entry.expires)) return "never";
  return new Date(entry.expires).toISOString();
}
function buildLitellmTools(deps) {
  const providerId = deps.providerId;
  const stateDir = deps.stateDir;
  const authPath = deps.authPath ?? defaultAuthPath();
  const timeout = deps.timeout;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  return {
    actsis_litellm_status: tool({
      description: "Show LiteLLM gateway status, credential state, and model cache age.",
      args: {},
      async execute(_args, _context) {
        const state = await readPluginState(stateDir);
        const entry = await readAuthEntry(authPath, providerId);
        const cached = await loadCachedModels(stateDir);
        const age = await computeCacheAge(stateDir);
        const gatewayUrl = state?.gatewayUrl ?? "not configured";
        const ageText = age === null ? "none" : `${Math.floor(age / 6e4)}m ago`;
        const cacheCount = cached ? Object.keys(cached).length : 0;
        const authType = entry?.type ?? "none";
        const authExpiry = formatExpiry(entry);
        let budgetLines = ["Budget: unavailable"];
        try {
          if (entry && state?.gatewayUrl) {
            const token = entry.type === "oauth" ? await ensureFreshToken(
              { access: entry.access, refresh: entry.refresh, expires: entry.expires },
              {
                state,
                timeoutMs: timeout,
                fetchImpl,
                onRefreshed: async (next) => {
                  await deps.input.client.auth.set({
                    path: { id: providerId },
                    body: { type: "oauth", ...next }
                  });
                }
              }
            ) : entry.key;
            const snapshot = await fetchGatewayBudget(state.gatewayUrl, token, timeout, fetchImpl);
            await updatePluginState(
              { lastBudgetSnapshot: snapshot, budgetRefreshedAt: Date.now() },
              stateDir
            );
            const primary = formatBudgetLine(snapshot.primary);
            if (primary) {
              budgetLines = [`Budget: ${primary}`];
              if (snapshot.source === "user_info") {
                for (const key of snapshot.ownKeys) {
                  const keyLine = formatBudgetLine(key);
                  if (keyLine) {
                    budgetLines.push(
                      key.keyAlias ? `Key ${key.keyAlias}: ${keyLine}` : `Key: ${keyLine}`
                    );
                  }
                }
              }
            }
          }
        } catch (err) {
          if (err instanceof AuthError) {
            budgetLines = ["Budget: Credential rejected \u2014 run /login again"];
          } else {
            const reason = err instanceof Error ? err.message : String(err);
            const cachedSnapshot = state?.lastBudgetSnapshot;
            const cachedAt = state?.budgetRefreshedAt;
            const cachedLine = cachedSnapshot && typeof cachedAt === "number" ? formatBudgetLine(cachedSnapshot.primary) : null;
            const cachedAgeSeconds = cachedSnapshot && typeof cachedAt === "number" ? Math.max(0, Math.floor((Date.now() - cachedAt) / 1e3)) : null;
            budgetLines = [
              `Budget unavailable: ${reason}`,
              ...cachedLine && cachedAgeSeconds !== null ? [`Budget (cached ${cachedAgeSeconds}s ago): ${cachedLine}`] : []
            ];
          }
        }
        const lines = [
          `Provider: ${providerId}`,
          `Auth: ${authType} (expires ${authExpiry})`,
          `Catalog: ${cacheCount} models cached (age ${ageText})`,
          `Gateway URL: ${gatewayUrl}`,
          ...budgetLines
        ];
        return lines.join("\n");
      }
    }),
    actsis_litellm_budget: tool({
      description: "Force a budget refresh and report the exact outcome.",
      args: {},
      async execute(_args, _context) {
        const state = await readPluginState(stateDir);
        const entry = await readAuthEntry(authPath, providerId);
        if (!state || !entry) {
          return "no credential stored \u2014 run /login";
        }
        if (!state.gatewayUrl) {
          return "gateway URL not configured";
        }
        try {
          const token = entry.type === "oauth" ? await ensureFreshToken(
            { access: entry.access, refresh: entry.refresh, expires: entry.expires },
            {
              state,
              timeoutMs: timeout,
              fetchImpl,
              onRefreshed: async (next) => {
                await deps.input.client.auth.set({
                  path: { id: providerId },
                  body: { type: "oauth", ...next }
                });
              }
            }
          ) : entry.key;
          const snapshot = await fetchGatewayBudget(state.gatewayUrl, token, timeout, fetchImpl);
          await updatePluginState(
            { lastBudgetSnapshot: snapshot, budgetRefreshedAt: Date.now() },
            stateDir
          );
          const text = formatBudgetStatus(snapshot.primary);
          return text ?? "no spend data (spend null)";
        } catch (err) {
          if (err instanceof AuthError) {
            return err.message;
          }
          const reason = err instanceof Error ? err.message : String(err);
          const cachedLine = state.lastBudgetSnapshot && state.budgetRefreshedAt ? formatBudgetLine(state.lastBudgetSnapshot.primary) : null;
          return `error: ${reason}${cachedLine ? ` (last known: ${cachedLine})` : ""}`;
        }
      }
    }),
    actsis_litellm_models: tool({
      description: "Force-sync the LiteLLM model catalog from the gateway.",
      args: {},
      async execute(_args, _context) {
        const entry = await readAuthEntry(authPath, providerId);
        if (!entry) {
          return "Not signed in \u2014 run /login and choose ACTSIS LiteLLM.";
        }
        const state = await readPluginState(stateDir);
        if (!state?.gatewayUrl) {
          return "Gateway URL not configured.";
        }
        const token = entry.type === "oauth" ? entry.access : entry.key;
        const previous = await loadCachedModels(stateDir);
        const previousIds = previous ? Object.keys(previous) : [];
        const previousSet = new Set(previousIds);
        const fresh = await fetchCatalogModels(
          {
            baseUrl: state.gatewayUrl,
            providerId,
            catalogTtlMs: 0,
            requestTimeoutMs: timeout
          },
          token,
          void 0,
          fetchImpl
        );
        const record = {};
        for (const model of fresh) {
          record[model.name] = model;
        }
        await saveCachedModels(record, stateDir);
        const currentIds = Object.keys(record);
        const added = currentIds.filter((id) => !previousSet.has(id)).length;
        const removed = previousIds.filter((id) => !record[id]).length;
        return `Model catalog synced: ${currentIds.length} models available (added ${added}, removed ${removed}). Restart OpenCode to see new models in the picker.`;
      }
    }),
    actsis_litellm_logout: tool({
      description: "Revoke LiteLLM credentials and clear local state.",
      args: {},
      async execute(_args, _context) {
        const state = await readPluginState(stateDir);
        const entry = await readAuthEntry(authPath, providerId);
        if (entry?.type === "oauth" && entry.refresh && state?.tokenEndpoint && state?.clientId) {
          try {
            await revokeToken(
              discoveryFromState(state),
              { token: entry.refresh, clientId: state.clientId },
              timeout,
              fetchImpl
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (message.toLowerCase().includes("fetch")) {
            }
          }
        }
        await clearAuthEntry(authPath, providerId);
        await writePluginState({ version: 1 }, stateDir);
        try {
          await rm3(cachePath2(stateDir), { force: true });
        } catch {
        }
        return "Logged out. Credentials revoked and local state cleared.";
      }
    })
  };
}

// src/index.ts
async function ActsisActiveLLMPlugin2(input, options) {
  const hooks = await ActsisActiveLLMPlugin(input, options);
  const tools = buildLitellmTools({
    providerId: hooks.provider?.id ?? "actsis-litellm",
    getState: async () => null,
    // not used; tools read state directly
    timeout: 3e4,
    input
  });
  hooks.tool = tools;
  return hooks;
}
var src_default = ActsisActiveLLMPlugin2;
export {
  ActsisActiveLLMPlugin2 as ActsisActiveLLMPlugin,
  src_default as default,
  ActsisActiveLLMPlugin2 as server
};

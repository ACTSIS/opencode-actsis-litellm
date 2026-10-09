// src/plugin.ts
import { Plugin, Provider as ProviderSchema, Model as ModelSchema } from "@opencode/plugin";

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

// src/tls-config.ts
var ONE_SHOT_ATTEMPTS = /* @__PURE__ */ new Set();
function normalizePem(cert) {
  return cert.replace(/\r/g, "").replace(/\s+/g, "\n").trim();
}
function parseOptOutEnv(value) {
  if (value === void 0) return false;
  return ["1", "true", "yes"].includes(value.trim().toLowerCase());
}
function unionCertificates(primary, secondary) {
  const merged = [];
  const seen = /* @__PURE__ */ new Set();
  for (const cert of [...primary, ...secondary]) {
    const key = normalizePem(cert);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(cert);
  }
  return merged;
}
function normalizedSet(certs) {
  const set = /* @__PURE__ */ new Set();
  for (const cert of certs) set.add(normalizePem(cert));
  return set;
}
async function loadTls() {
  const mod = await import("tls");
  if (typeof mod.getCACertificates !== "function" || typeof mod.setDefaultCACertificates !== "function") {
    throw new Error("runtime lacks node:tls CA management APIs");
  }
  return mod;
}
async function configureSystemCa(options = {}) {
  const onceKey = options.onceKey ?? "default";
  if (parseOptOutEnv(options.optOutEnv)) {
    return { kind: "disabled" };
  }
  if (ONE_SHOT_ATTEMPTS.has(onceKey)) {
    return { kind: "already-configured" };
  }
  ONE_SHOT_ATTEMPTS.add(onceKey);
  let tlsApi;
  try {
    tlsApi = options.tlsOverride ?? await loadTls();
  } catch (err) {
    return {
      kind: "unsupported",
      reason: err instanceof Error ? err.message : String(err)
    };
  }
  try {
    const bundled = tlsApi.getCACertificates("bundled");
    let system;
    try {
      system = tlsApi.getCACertificates("system");
    } catch (err) {
      return {
        kind: "failed",
        reason: err instanceof Error ? `node:tls rejected the "system" source: ${err.message}` : String(err)
      };
    }
    const bundledSet = normalizedSet(bundled);
    const systemSet = normalizedSet(system);
    const added = [...systemSet].filter((c) => !bundledSet.has(c));
    if (added.length === 0) {
      return { kind: "empty-system", addedCertificates: 0 };
    }
    const merged = unionCertificates(bundled, system);
    tlsApi.setDefaultCACertificates(merged);
    return { kind: "configured", addedCertificates: added.length };
  } catch (err) {
    return {
      kind: "failed",
      reason: err instanceof Error ? err.message : String(err)
    };
  }
}
var TLS_TRUST_ERROR_CODES = /* @__PURE__ */ new Set([
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_SIGNATURE_FAILURE",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID"
]);
function isTlsTrustIssueCode(code) {
  if (code === void 0) return false;
  return TLS_TRUST_ERROR_CODES.has(code) || code.startsWith("ERR_SSL");
}
function tlsTrustRemediationMessage(code) {
  if (!isTlsTrustIssueCode(code)) return null;
  return "the gateway's TLS certificate is not trusted by Node (Node ignores the OS certificate store by default). This plugin auto-loads OS system CAs at startup (--use-system-ca equivalent); to opt out set ACTSIS_LITELLM_NO_SYSTEM_CA=1. If trust still fails: on Windows run `setx NODE_USE_SYSTEM_CA 1` (Node \u2265 22.19.0, CA present in certmgr.msc) or export the CA to PEM (`certutil -encode ca.cer ca.pem`) and set NODE_EXTRA_CA_CERTS to it; on Linux use --use-openssl-ca / SSL_CERT_FILE.";
}

// src/network-error.ts
var MAX_CHAIN_DEPTH = 5;
var HINTS = [
  {
    match: (link) => link.code === "ENOTFOUND" || link.code === "EAI_AGAIN",
    text: "the gateway host could not be resolved; check the configured URL and DNS/VPN."
  },
  {
    match: (link) => link.code === "ECONNREFUSED",
    text: "the connection was refused; check that the gateway is running and reachable."
  },
  {
    match: (link) => [
      "ETIMEDOUT",
      "ESOCKETTIMEDOUT",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT"
    ].includes(link.code ?? "") || isTimeoutLink(link),
    text: "the request timed out before the gateway responded."
  },
  {
    match: (link) => link.code === "ECONNRESET",
    text: "the connection was reset by the peer."
  }
];
function isTimeoutLink(link) {
  if (link.name === "TimeoutError") return true;
  if (link.code === "23") return true;
  return false;
}
function hintFor(link) {
  if (isTlsTrustIssueCode(link.code)) {
    return tlsTrustRemediationMessage(link.code) ?? "";
  }
  const hint = HINTS.find((h) => h.match(link));
  return hint ? hint.text : "";
}
function readCode(value) {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return void 0;
}
function fetchFailureMessage(err) {
  if (!(err instanceof Error)) {
    return String(err);
  }
  const links = [];
  const visited = /* @__PURE__ */ new Set();
  let current = err;
  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
    if (!(current instanceof Error)) break;
    if (visited.has(current)) break;
    visited.add(current);
    const rawCode = current.code;
    links.push({
      name: current.name,
      code: readCode(rawCode),
      message: current.message
    });
    const cause = current.cause;
    if (cause === null || cause === void 0 || typeof cause !== "object") {
      break;
    }
    current = cause;
  }
  const hasCause = links.length > 1;
  const hasCode = links.some((l) => l.code !== void 0);
  if (!hasCause && !hasCode) {
    return err.message;
  }
  let deepest = links[links.length - 1];
  for (let i = links.length - 1; i >= 0; i--) {
    if (links[i].code !== void 0) {
      deepest = links[i];
      break;
    }
  }
  const codeOrName = deepest.code ?? deepest.name;
  const hintSuffix = hintFor(deepest);
  return `${err.message} (${codeOrName}: ${deepest.message})${hintSuffix ? ` ${hintSuffix}` : ""}`;
}

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
async function fetchOrThrow(url, init, makeError, label, fetchImpl) {
  try {
    return await fetchImpl(url, init);
  } catch (err) {
    throw makeError(`${label}: ${fetchFailureMessage(err)}`, err);
  }
}
function authFetchOrThrow(url, init, label, timeoutMs, fetchImpl) {
  return fetchOrThrow(
    url,
    { signal: AbortSignal.timeout(timeoutMs), ...init },
    (message, cause) => new AuthError(message, { cause }),
    label,
    fetchImpl
  );
}
function catalogFetchOrThrow(url, init, label, timeoutMs, fetchImpl) {
  return fetchOrThrow(
    url,
    { signal: AbortSignal.timeout(timeoutMs), ...init },
    (message, cause) => new CatalogError(message, { cause }),
    label,
    fetchImpl
  );
}
async function fetchCliAuthDiscovery(baseUrl, timeoutMs, onAdaptation, fetchImpl = globalThis.fetch) {
  let response;
  try {
    response = await fetchImpl(discoveryUrl(baseUrl), {
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    throw new DiscoveryError(
      `Failed to fetch CLI auth discovery: ${fetchFailureMessage(err)}`,
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
  const response = await authFetchOrThrow(
    discovery.registrationEndpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "opencode-actsis-litellm",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"]
      }),
      redirect: "manual"
    },
    "Client registration request failed",
    timeoutMs,
    fetchImpl
  );
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
  const response = await authFetchOrThrow(
    discovery.tokenEndpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "manual"
    },
    "Token endpoint request failed",
    timeoutMs,
    fetchImpl
  );
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
  const response = await authFetchOrThrow(
    discovery.tokenEndpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "manual"
    },
    "Token refresh request failed",
    timeoutMs,
    fetchImpl
  );
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
  const response = await authFetchOrThrow(
    discovery.revocationEndpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "manual"
    },
    "Token revocation request failed",
    timeoutMs,
    fetchImpl
  );
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
  const response = await catalogFetchOrThrow(
    `${normalized}/v1/models?include_metadata=true`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    },
    "Failed to fetch models",
    timeoutMs,
    fetchImpl
  );
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
  const response = await catalogFetchOrThrow(
    `${normalized}/v2/model/info?${params.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    },
    `Failed to fetch model info (v2 page ${page})`,
    timeoutMs,
    fetchImpl
  );
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
  const response = await catalogFetchOrThrow(
    `${normalized}/v1/model/info`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    },
    "Failed to fetch model info",
    timeoutMs,
    fetchImpl
  );
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
        await updatePluginState(
          {
            gatewayUrl: discovery.issuer,
            providerId: void 0,
            authMode: "oauth",
            clientId,
            tokenEndpoint: discovery.tokenEndpoint,
            revocationEndpoint: discovery.revocationEndpoint,
            resource: discovery.resource,
            schemeUpgraded: notices?.schemeUpgraded,
            savedAt: Date.now()
          },
          config.stateDir
        );
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
      `Failed to fetch ${label}: ${fetchFailureMessage(err)}`,
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

// src/preferences.ts
import path4 from "path";
import { mkdir as mkdir3, readFile as readFile4, writeFile as writeFile4, rm as rm3 } from "fs/promises";
import { renameSync as renameSync3 } from "fs";
import os4 from "os";
var PREFS_SCHEMA_VERSION = 1;
var DEFAULT_APP_DIR_NAME3 = "opencode";
var DEFAULT_PLUGIN_DIR_NAME3 = "actsis-litellm";
var PREFS_FILE_NAME = "preferences.json";
function defaultPreferences() {
  return { version: PREFS_SCHEMA_VERSION, topModelsWidget: true };
}
function defaultPluginDir3() {
  const dataHome = process.env.XDG_DATA_HOME ? process.env.XDG_DATA_HOME : path4.join(os4.homedir(), ".local", "share");
  return path4.join(dataHome, DEFAULT_APP_DIR_NAME3, DEFAULT_PLUGIN_DIR_NAME3);
}
function preferencesPath(dir) {
  return path4.join(dir ?? defaultPluginDir3(), PREFS_FILE_NAME);
}
async function readPreferences(dir) {
  try {
    const raw = await readFile4(preferencesPath(dir), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return defaultPreferences();
    }
    const version = typeof parsed.version === "number" ? parsed.version : PREFS_SCHEMA_VERSION;
    if (version !== PREFS_SCHEMA_VERSION) {
      return defaultPreferences();
    }
    return {
      version: PREFS_SCHEMA_VERSION,
      topModelsWidget: typeof parsed.topModelsWidget === "boolean" ? parsed.topModelsWidget : defaultPreferences().topModelsWidget
    };
  } catch {
    return defaultPreferences();
  }
}
function readTopModelsWidgetEnabled(dir) {
  return readPreferences(dir).then((prefs) => prefs.topModelsWidget);
}
async function updateTopModelsWidgetEnabled(enabled, dir) {
  try {
    await writePreferences(
      { ...defaultPreferences(), ...await readPreferences(dir), topModelsWidget: enabled },
      dir
    );
  } catch {
  }
}
async function writePreferences(prefs, dir) {
  const file = preferencesPath(dir);
  await mkdir3(path4.dirname(file), { recursive: true });
  const tmpFile = `${file}.tmp.${process.pid}`;
  try {
    const toWrite = {
      ...prefs,
      version: PREFS_SCHEMA_VERSION
    };
    await writeFile4(tmpFile, JSON.stringify(toWrite, null, 2), "utf8");
    renameSync3(tmpFile, file);
  } catch (err) {
    try {
      await rm3(tmpFile, { force: true });
    } catch {
    }
    throw err;
  }
}

// src/top-widget.ts
import { readFile as readFile5 } from "fs/promises";
import os5 from "os";
import path5 from "path";

// src/usage.ts
var DAY_MS = 24 * 60 * 60 * 1e3;
var MAX_USAGE_PAGES = 50;
var USAGE_PAGE_SIZE = 200;
function asNullableNumber2(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}
function asRecord2(value) {
  return typeof value === "object" && value !== null ? value : {};
}
function isoDay(ms) {
  const d = new Date(ms);
  const y = String(d.getUTCFullYear()).padStart(4, "0");
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function parseIsoDayOrNull(value) {
  if (!value) return null;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(parsed) ? null : parsed;
}
function addDays(day, days) {
  const base = parseIsoDayOrNull(day);
  if (base === null) return day;
  return isoDay(base + days * DAY_MS);
}
function resolveDefaultUsageRange(nowMs) {
  const now = typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : Date.now();
  const endDate = isoDay(now);
  return { startDate: addDays(endDate, -29), endDate };
}
function resolveUsageRangeDays(days, nowMs) {
  const now = typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : Date.now();
  const clamped = Math.max(1, Math.floor(days));
  const endDate = isoDay(now);
  const startDate = isoDay(now - (clamped - 1) * DAY_MS);
  return { startDate, endDate };
}
function rangeLengthDays(range) {
  const start = parseIsoDayOrNull(range.startDate);
  const end = parseIsoDayOrNull(range.endDate);
  if (start === null || end === null) return 0;
  return Math.round((end - start) / DAY_MS) + 1;
}
function extractCredentialUserId(credential) {
  const metadata = asRecord2(credential?.metadata);
  const userId = metadata.userId;
  return typeof userId === "string" && userId ? userId : null;
}
function parseUsagePage(body) {
  const record = asRecord2(body);
  const metadata = asRecord2(record.metadata);
  return {
    results: Array.isArray(record.results) ? record.results.map(asRecord2) : [],
    metadata,
    hasMore: metadata.has_more === true,
    totalPages: asNullableNumber2(metadata.total_pages)
  };
}
function parseNotFound(status) {
  return status === 404 || status === 405;
}
async function requestUsagePage(baseUrl, apiKey, timeoutMs, range, filters, fetchImpl) {
  const normalized = baseUrl.replace(/\/+$/, "");
  const path7 = filters.aggregated ? `${normalized}/user/daily/activity/aggregated` : `${normalized}/user/daily/activity`;
  const params = new URLSearchParams({
    start_date: range.startDate,
    end_date: range.endDate
  });
  if (filters.userId) params.set("user_id", filters.userId);
  if (filters.page !== void 0) params.set("page", String(filters.page));
  if (filters.pageSize !== void 0) params.set("page_size", String(filters.pageSize));
  let response;
  try {
    response = await fetchImpl(`${path7}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    throw new CatalogError(
      `Failed to fetch model usage: ${fetchFailureMessage(err)}`,
      { cause: err }
    );
  }
  if (parseNotFound(response.status)) {
    return { found: false };
  }
  if (response.status === 401) {
    throw new AuthError("Credential rejected by gateway. Run /login again.");
  }
  if (response.status === 403) {
    throw new AuthError(
      "Gateway denied access to usage info (403): this credential lacks the spend/usage routes permission. Ask a gateway admin to grant it."
    );
  }
  if (!response.ok) {
    throw new CatalogError(
      `Failed to fetch model usage: ${response.status}: ${response.statusText}`
    );
  }
  let body;
  try {
    body = await response.json();
  } catch (err) {
    throw new CatalogError(
      `Model usage response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
  return { found: true, body };
}
async function fetchModelUsage(baseUrl, apiKey, timeoutMs, range, options = {}, fetchImpl = globalThis.fetch) {
  const defaultRange = resolveDefaultUsageRange();
  const effectiveRange = {
    startDate: range?.startDate ?? defaultRange.startDate,
    endDate: range?.endDate ?? defaultRange.endDate
  };
  const aggregated = await requestUsagePage(baseUrl, apiKey, timeoutMs, effectiveRange, {
    userId: options.userId,
    aggregated: true
  }, fetchImpl);
  if (aggregated.found && aggregated.body !== void 0) {
    return summarizeUsage(effectiveRange, [parseUsagePage(aggregated.body)], {
      adoptMetadataTotals: true
    });
  }
  const pages = [];
  for (let page = 1; page <= MAX_USAGE_PAGES; page++) {
    const result = await requestUsagePage(baseUrl, apiKey, timeoutMs, effectiveRange, {
      userId: options.userId,
      aggregated: false,
      page,
      pageSize: USAGE_PAGE_SIZE
    }, fetchImpl);
    if (result.found && result.body !== void 0) {
      const parsed = parseUsagePage(result.body);
      pages.push(parsed);
      if (!parsed.hasMore) break;
    } else {
      break;
    }
  }
  if (pages.length === 0) {
    throw new CatalogError("Failed to fetch model usage: no usage endpoint available");
  }
  const singlePage = pages.length === 1 && pages[0].totalPages !== null && pages[0].totalPages <= 1;
  return summarizeUsage(effectiveRange, pages, {
    adoptMetadataTotals: singlePage
  });
}
function readMetrics(record) {
  const nested = asRecord2(record.metrics);
  return { ...record, ...nested };
}
function newAggregator() {
  return { spend: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, apiRequests: 0 };
}
function accumulate(totals, metrics) {
  totals.spend += asNullableNumber2(metrics.spend) ?? 0;
  totals.promptTokens += asNullableNumber2(metrics.prompt_tokens) ?? 0;
  totals.completionTokens += asNullableNumber2(metrics.completion_tokens) ?? 0;
  totals.totalTokens += asNullableNumber2(metrics.total_tokens) ?? 0;
  totals.apiRequests += asNullableNumber2(metrics.api_requests) ?? 0;
}
function toSummary(range, totals, perModel) {
  const models = [...perModel.entries()].map(([model, agg]) => ({
    model,
    spend: agg.spend,
    promptTokens: agg.promptTokens,
    completionTokens: agg.completionTokens,
    totalTokens: agg.totalTokens,
    apiRequests: agg.apiRequests
  })).sort((a, b) => (b.spend ?? 0) - (a.spend ?? 0) || a.model.localeCompare(b.model));
  return {
    startDate: range.startDate,
    endDate: range.endDate,
    totals: {
      spend: totals.spend,
      promptTokens: totals.promptTokens,
      completionTokens: totals.completionTokens,
      totalTokens: totals.totalTokens,
      apiRequests: totals.apiRequests
    },
    models
  };
}
function summarizeUsage(range, pages, opts) {
  const totalsAgg = newAggregator();
  const perModel = /* @__PURE__ */ new Map();
  for (const pageData of pages) {
    for (const row of pageData.results) {
      accumulate(totalsAgg, readMetrics(row));
      const breakdown = asRecord2(row.breakdown);
      const models = asRecord2(breakdown.models);
      for (const [model, rawMetrics] of Object.entries(models)) {
        const agg = perModel.get(model) ?? newAggregator();
        accumulate(agg, readMetrics(asRecord2(rawMetrics)));
        perModel.set(model, agg);
      }
    }
  }
  if (opts.adoptMetadataTotals && pages.length === 1) {
    const metadata = pages[0].metadata;
    const metadataFields = [
      ["spend", metadata.total_spend],
      ["promptTokens", metadata.total_prompt_tokens],
      ["completionTokens", metadata.total_completion_tokens],
      ["totalTokens", metadata.total_tokens],
      ["apiRequests", metadata.total_api_requests]
    ];
    for (const [field, value] of metadataFields) {
      const n = asNullableNumber2(value);
      if (n !== null) totalsAgg[field] = n;
    }
  }
  const modelSpendSum = [...perModel.values()].reduce((sum, m) => sum + m.spend, 0);
  if (modelSpendSum > totalsAgg.spend) {
    totalsAgg.spend = modelSpendSum;
  }
  return toSummary(range, totalsAgg, perModel);
}
async function fetchGatewayRequests(baseUrl, apiKey, timeoutMs, range, options = {}, fetchImpl = globalThis.fetch) {
  const normalized = baseUrl.replace(/\/+$/, "");
  const defaultRange = resolveDefaultUsageRange();
  const params = new URLSearchParams({
    start_date: range.startDate ?? defaultRange.startDate,
    end_date: range.endDate ?? defaultRange.endDate
  });
  if (options.userId) params.set("user_id", options.userId);
  let response;
  try {
    response = await fetchImpl(`${normalized}/gateway/daily/activity?${params.toString()}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    throw new CatalogError(
      `Failed to fetch gateway activity: ${fetchFailureMessage(err)}`,
      { cause: err }
    );
  }
  if (parseNotFound(response.status)) return null;
  if (response.status === 401) {
    throw new AuthError("Credential rejected by gateway. Run /login again.");
  }
  if (response.status === 403) {
    throw new AuthError(
      "Gateway denied access to gateway activity (403): this credential lacks the required permission. Ask a gateway admin to grant it."
    );
  }
  if (!response.ok) {
    throw new CatalogError(
      `Failed to fetch gateway activity: ${response.status}: ${response.statusText}`
    );
  }
  let parsed;
  try {
    parsed = await response.json();
  } catch (err) {
    throw new CatalogError(
      `Gateway activity response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
  const record = asRecord2(parsed);
  const metadata = asRecord2(record.metadata);
  const merged = { ...record, ...metadata };
  const successful = asNullableNumber2(merged.total_successful_requests) ?? 0;
  const failed = asNullableNumber2(merged.total_failed_requests) ?? 0;
  const totalMeta = asNullableNumber2(merged.total_requests);
  return { successful, failed, total: totalMeta ?? successful + failed };
}
function mapModelAliases(modelKeys, publicIds) {
  const aliases = /* @__PURE__ */ new Map();
  const publicSet = new Set(publicIds);
  const suffixIndex = /* @__PURE__ */ new Map();
  for (const id of [...publicIds].sort()) {
    const suffix = id.split("/").pop().toLowerCase();
    if (!suffixIndex.has(suffix)) suffixIndex.set(suffix, id);
  }
  for (const key of modelKeys) {
    if (!key || publicSet.has(key)) continue;
    const normalized = key.split("/").pop().toLowerCase();
    const publicId = suffixIndex.get(normalized);
    if (publicId) aliases.set(key, publicId);
  }
  return aliases;
}
function applyModelAliases(summary, aliases) {
  if (aliases.size === 0) {
    return { ...summary, models: summary.models.map((m) => ({ ...m })) };
  }
  const merged = /* @__PURE__ */ new Map();
  for (const entry of summary.models) {
    const name = aliases.get(entry.model) ?? entry.model;
    const existing = merged.get(name);
    if (existing) {
      existing.spend = (existing.spend ?? 0) + (entry.spend ?? 0);
      existing.promptTokens = (existing.promptTokens ?? 0) + (entry.promptTokens ?? 0);
      existing.completionTokens = (existing.completionTokens ?? 0) + (entry.completionTokens ?? 0);
      existing.totalTokens = (existing.totalTokens ?? 0) + (entry.totalTokens ?? 0);
      existing.apiRequests = (existing.apiRequests ?? 0) + (entry.apiRequests ?? 0);
    } else {
      merged.set(name, { ...entry, model: name });
    }
  }
  return {
    ...summary,
    models: [...merged.values()].sort(
      (a, b) => (b.spend ?? 0) - (a.spend ?? 0) || a.model.localeCompare(b.model)
    )
  };
}
function formatCompactTokens(tokens) {
  if (tokens === null || tokens === void 0) return "-";
  if (tokens >= 1e9) return `${(tokens / 1e9).toFixed(2)}B`;
  if (tokens >= 1e6) {
    const millions = tokens / 1e6;
    return `${millions.toFixed(millions < 10 ? 2 : 1)}M`;
  }
  if (tokens >= 1e3) return `${(tokens / 1e3).toFixed(1)}k`;
  return String(tokens);
}
function buildTable(entries, totalsSpend, totals) {
  const names = entries.map((e) => e.model);
  const nameWidth = Math.max("Model".length, ...names.map((n) => n.length));
  const spendWidth = Math.max(
    "Spend".length,
    ...entries.map((e) => (e.spend === null ? "-" : `$${e.spend.toFixed(4)}`).length),
    `$${totalsSpend.toFixed(4)}`.length
  );
  const tokenWidth = Math.max(
    "Tokens".length,
    ...entries.map((e) => formatCompactTokens(e.totalTokens).length),
    formatCompactTokens(totals.totalTokens ?? null).length
  );
  const reqWidth = Math.max(
    "Reqs".length,
    ...entries.map((e) => (e.apiRequests === null ? "-" : String(e.apiRequests)).length),
    String(totals.totalApiRequests ?? 0).length
  );
  const renderRow = (model, spend, tokens, reqs) => `${model.padEnd(nameWidth)}  ${spend.padStart(spendWidth)}  ${tokens.padStart(tokenWidth)}  ${reqs.padStart(reqWidth)}`;
  const lines = [];
  const separator = "-".repeat(nameWidth + spendWidth + tokenWidth + reqWidth + 6);
  lines.push(renderRow("Model", "Spend", "Tokens", "Reqs"));
  lines.push(separator);
  for (const entry of entries) {
    lines.push(
      renderRow(
        entry.model,
        entry.spend === null ? "-" : `$${entry.spend.toFixed(4)}`,
        formatCompactTokens(entry.totalTokens),
        entry.apiRequests === null ? "-" : String(entry.apiRequests)
      )
    );
  }
  if (entries.length > 0) {
    lines.push(separator);
    lines.push(
      renderRow(
        "Total",
        `$${totalsSpend.toFixed(4)}`,
        formatCompactTokens(totals.totalTokens ?? null),
        String(totals.totalApiRequests ?? 0)
      )
    );
  }
  return lines;
}
function formatUsageTable(summary, options = {}) {
  const lines = [];
  const totalSpend = summary.totals.spend ?? 0;
  const header = `Usage ${summary.startDate} \u2192 ${summary.endDate} (${rangeLengthDays(summary)} days): $${totalSpend.toFixed(4)}`;
  lines.push(header);
  if (summary.models.length === 0) {
    lines.push("(no logged model usage in this range)");
    return lines;
  }
  const topN = typeof options.topN === "number" && options.topN > 0 ? options.topN : void 0;
  const rows = topN !== void 0 ? summary.models.slice(0, topN) : summary.models;
  lines.push(...buildTable(rows, totalSpend, {
    totalTokens: summary.totals.totalTokens,
    totalApiRequests: summary.totals.apiRequests
  }));
  if (topN !== void 0 && summary.models.length > topN) {
    lines.splice(lines.length - 1, 0, `(+${summary.models.length - topN} more models)`);
  }
  return lines;
}

// src/top-widget.ts
var TOP_MODELS_ROW_LIMIT = 5;
var TOP_MODELS_WINDOW_DAYS = 7;
var TOP_WIDGET_WINDOW_LABEL = "7d";
var TOP_MODELS_TTL_MS = 5 * 60 * 1e3;
var WIDGET_SPEND_MIN_WIDTH = "$0.00".length;
function computeTopModelRows(summary, publicIds) {
  const display = applyModelAliases(
    summary,
    mapModelAliases(
      summary.models.map((m) => m.model),
      publicIds
    )
  );
  return {
    rows: display.models.slice(0, TOP_MODELS_ROW_LIMIT).map((m) => ({ model: m.model, spend: m.spend ?? 0 })),
    totalSpend: display.totals.spend ?? 0
  };
}

// src/top-command.ts
function parseTopPrefArg(args, current) {
  const trimmed = (args ?? "").trim().toLowerCase();
  if (trimmed === "") {
    const next = !current;
    return { state: next ? "on" : "off", changed: true };
  }
  if (trimmed === "on" || trimmed === "off") {
    const next = trimmed === "on";
    return { state: next ? "on" : "off", changed: next !== current };
  }
  return { error: "expected nothing (toggle), `on`, or `off`" };
}
function formatTopToggleAnswer(parsed) {
  return `Top-5 widget: ${parsed.state}${parsed.changed ? " (saved)" : " (already)"}`;
}

// src/usage-command.ts
var RANGE_ARG_RE = /^(\d{4}-\d{2}-\d{2})\s+(?:to|→|\.\.|,)\s+(\d{4}-\d{2}-\d{2})$/;
function parseUsageRangeArg(args, nowMs) {
  const trimmed = (args ?? "").trim();
  const now = typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : Date.now();
  const defaults = resolveDefaultUsageRange(now);
  if (!trimmed) {
    return { range: defaults, label: "last 30 days" };
  }
  if (/^\d+$/.test(trimmed)) {
    const days = Math.max(1, parseInt(trimmed, 10));
    const end = isoDay(now);
    const start = isoDay(now - (days - 1) * 24 * 60 * 60 * 1e3);
    return {
      range: { startDate: start, endDate: end },
      label: `last ${days} day${days === 1 ? "" : "s"}`
    };
  }
  const rangeMatch = trimmed.match(RANGE_ARG_RE);
  if (rangeMatch) {
    const [, start, end] = rangeMatch;
    if (Date.parse(`${start}T00:00:00Z`) > Date.parse(`${end}T00:00:00Z`)) {
      return { error: `start date ${start} is after end date ${end}` };
    }
    return { range: { startDate: start, endDate: end }, label: `${start} \u2192 ${end}` };
  }
  return {
    error: "expected nothing (last 30 days), a day count like `14`, or a range like `2025-03-01 .. 2025-03-31`"
  };
}

// src/tools.ts
import path6 from "path";
import os6 from "os";
import { rm as rm4 } from "fs/promises";
var DEFAULT_PLUGIN_DIR_NAME4 = "actsis-litellm";
var DEFAULT_APP_DIR_NAME4 = "opencode";
var DEFAULT_TIMEOUT_MS = 3e4;
var CACHE_FILE_NAME2 = "models-cache.json";
function defaultPluginDir4() {
  const dataHome = process.env.XDG_DATA_HOME ? process.env.XDG_DATA_HOME : path6.join(os6.homedir(), ".local", "share");
  return path6.join(dataHome, DEFAULT_APP_DIR_NAME4, DEFAULT_PLUGIN_DIR_NAME4);
}
function cachePath2(dir) {
  return path6.join(dir ?? defaultPluginDir4(), CACHE_FILE_NAME2);
}
function formatExpiry(entry) {
  if (!entry) return "never";
  if (entry.type === "api") return "never";
  if (!Number.isFinite(entry.expires)) return "never";
  return new Date(entry.expires).toISOString();
}
var EMPTY_INPUT = { type: "object", properties: {}, additionalProperties: false };
var USAGE_INPUT = {
  type: "object",
  properties: {
    args: {
      type: "string",
      description: "Optional usage window: a day count like 14, or a range like '2025-03-01 .. 2025-03-31'. Omit for the last 30 days."
    }
  },
  additionalProperties: false
};
var TOP_INPUT = {
  type: "object",
  properties: {
    args: {
      type: "string",
      description: "Optional action: 'on', 'off', or 'toggle'. Omit to toggle the current state."
    }
  },
  additionalProperties: false
};
async function resolveToolToken(deps) {
  const {
    providerId,
    stateDir,
    authPath = defaultAuthPath(),
    fetchImpl,
    timeout = DEFAULT_TIMEOUT_MS
  } = deps;
  const state = await readPluginState(stateDir);
  const entry = await readEntry(deps);
  if (!entry) {
    return { state, entry: null, token: null };
  }
  if (entry.type === "api") {
    return { state, entry, token: entry.key };
  }
  const token = await ensureFreshToken(
    { access: entry.access, refresh: entry.refresh, expires: entry.expires },
    {
      state,
      timeoutMs: timeout,
      fetchImpl
    }
  );
  return { state, entry, token: token || null };
}
async function readEntry(deps) {
  if (deps.getCredential) {
    try {
      const cred = await deps.getCredential();
      if (cred) {
        const normalized = normalizeCredential(cred);
        if (normalized) return normalized;
      }
    } catch {
    }
  }
  return readAuthEntry(deps.authPath ?? defaultAuthPath(), deps.providerId);
}
function normalizeCredential(cred) {
  if (cred.type === "oauth") {
    if (typeof cred.access !== "string" || !cred.access) return null;
    if (typeof cred.refresh !== "string" || !cred.refresh) return null;
    if (typeof cred.expires !== "number") return null;
    return { type: "oauth", access: cred.access, refresh: cred.refresh, expires: cred.expires };
  }
  if (cred.type === "key") {
    if (typeof cred.key !== "string" || !cred.key) return null;
    return { type: "api", key: cred.key };
  }
  return null;
}
function buildLitellmToolInfos(deps) {
  const {
    providerId,
    stateDir,
    authPath = defaultAuthPath(),
    fetchImpl = globalThis.fetch,
    timeout = DEFAULT_TIMEOUT_MS,
    onRefreshed
  } = deps;
  const status = async () => {
    const state = await readPluginState(stateDir);
    const entry = await readEntry(deps);
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
            onRefreshed
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
  };
  const budget = async () => {
    const state = await readPluginState(stateDir);
    const entry = await readEntry(deps);
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
          onRefreshed
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
  };
  const models = async () => {
    const entry = await readEntry(deps);
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
  };
  const credentialMetadata = async () => {
    if (!deps.getCredential) return null;
    try {
      const cred = await deps.getCredential();
      return cred ?? null;
    } catch {
      return null;
    }
  };
  const usage = async (args) => {
    const parsed = parseUsageRangeArg(args);
    if ("error" in parsed) {
      return `Invalid window: ${parsed.error} \u2014 e.g. 14, or 2025-03-01 .. 2025-03-31; omit the argument for the last 30 days.`;
    }
    const state = await readPluginState(stateDir);
    const entry = await readEntry(deps);
    if (!entry) {
      return "Not signed in \u2014 run /login and choose ACTSIS LiteLLM.";
    }
    if (!state?.gatewayUrl) {
      return "Gateway URL not configured.";
    }
    try {
      const token = entry.type === "oauth" ? await ensureFreshToken(
        { access: entry.access, refresh: entry.refresh, expires: entry.expires },
        {
          state,
          timeoutMs: timeout,
          fetchImpl,
          onRefreshed
        }
      ) : entry.key;
      const userId = extractCredentialUserId(await credentialMetadata()) ?? void 0;
      const summary = await fetchModelUsage(
        state.gatewayUrl,
        token,
        timeout,
        parsed.range,
        { userId },
        fetchImpl
      );
      const cached = await loadCachedModels(stateDir);
      const publicIds = cached ? Object.keys(cached) : [];
      const display = applyModelAliases(
        summary,
        mapModelAliases(
          summary.models.map((m) => m.model),
          publicIds
        )
      );
      const lines = [`Usage (${parsed.label}):`, ...formatUsageTable(display)];
      try {
        const gateway = await fetchGatewayRequests(
          state.gatewayUrl,
          token,
          timeout,
          parsed.range,
          { userId },
          fetchImpl
        );
        if (gateway) {
          lines.push(
            `Gateway requests: ${gateway.total.toLocaleString("en-US")} (successful ${gateway.successful.toLocaleString("en-US")} \xB7 failed ${gateway.failed.toLocaleString("en-US")}) \u2014 includes non-logged traffic`
          );
        }
      } catch {
      }
      return lines.join("\n");
    } catch (err) {
      if (err instanceof AuthError) {
        return err.message;
      }
      const reason = err instanceof Error ? err.message : String(err);
      return `Usage unavailable: ${reason}`;
    }
  };
  const top = async (args) => {
    const enabled = await readTopModelsWidgetEnabled(stateDir);
    const parsed = parseTopPrefArg(args, enabled);
    if ("error" in parsed) {
      return `Invalid argument: ${parsed.error} \u2014 pass on, off, toggle, or omit args to toggle. Top-5 widget state unchanged.`;
    }
    if (parsed.changed) {
      await updateTopModelsWidgetEnabled(parsed.state === "on", stateDir);
    }
    if (parsed.state === "off") {
      const state2 = await readPluginState(stateDir);
      if (state2?.lastTopModels?.length) {
        await updatePluginState(
          { lastTopModels: [], topRefreshedAt: void 0 },
          stateDir
        );
      }
      return `${formatTopToggleAnswer(parsed)}. Widget rows cleared; gateway queries stopped.`;
    }
    const state = await readPluginState(stateDir);
    const entry = await readEntry(deps);
    if (!state?.gatewayUrl || !entry) {
      return `${formatTopToggleAnswer(parsed)}. Widget rows unavailable: no gateway URL or credentials.`;
    }
    try {
      const token = entry.type === "oauth" ? await ensureFreshToken(
        { access: entry.access, refresh: entry.refresh, expires: entry.expires },
        {
          state,
          timeoutMs: timeout,
          fetchImpl,
          onRefreshed
        }
      ) : entry.key;
      const userId = extractCredentialUserId(await credentialMetadata()) ?? void 0;
      const summary = await fetchModelUsage(
        state.gatewayUrl,
        token,
        timeout,
        resolveUsageRangeDays(TOP_MODELS_WINDOW_DAYS),
        { userId },
        fetchImpl
      );
      if (summary.models.length === 0 || (summary.totals.spend ?? 0) <= 0) {
        await updatePluginState(
          { lastTopModels: [], topRefreshedAt: void 0 },
          stateDir
        );
        return `${formatTopToggleAnswer(parsed)}. No logged spend in the last ${TOP_MODELS_WINDOW_DAYS} days to show.`;
      }
      const cached = await loadCachedModels(stateDir);
      const { rows, totalSpend } = computeTopModelRows(
        summary,
        cached ? Object.keys(cached) : []
      );
      await updatePluginState(
        {
          lastTopModels: rows.slice(0, TOP_MODELS_ROW_LIMIT),
          topRefreshedAt: Date.now(),
          topWindowLabel: TOP_WIDGET_WINDOW_LABEL,
          topTotalSpend: totalSpend
        },
        stateDir
      );
      return `${formatTopToggleAnswer(parsed)}. Top-5 rows refreshed (last ${TOP_MODELS_WINDOW_DAYS} days).`;
    } catch (err) {
      if (err instanceof AuthError) {
        return `${formatTopToggleAnswer(parsed)}. Widget rows unavailable: ${err.message}`;
      }
      const reason = err instanceof Error ? err.message : String(err);
      return `${formatTopToggleAnswer(parsed)}. Widget rows unavailable: ${reason}`;
    }
  };
  const logout = async () => {
    const state = await readPluginState(stateDir);
    const entry = await readEntry(deps);
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
      await rm4(cachePath2(stateDir), { force: true });
    } catch {
    }
    return [
      "Logged out. Local state and model cache cleared.",
      "OpenCode still holds the integration credential; disconnect it via the native auth UI \u2014 the plugin has no API to delete it."
    ].join("\n");
  };
  return [
    {
      name: "actsis_litellm_status",
      description: "Show LiteLLM gateway status, credential state, and model cache age.",
      input: EMPTY_INPUT,
      async execute() {
        return { content: await status() };
      }
    },
    {
      name: "actsis_litellm_budget",
      description: "Force a budget refresh and report the exact outcome.",
      input: EMPTY_INPUT,
      async execute() {
        return { content: await budget() };
      }
    },
    {
      name: "actsis_litellm_models",
      description: "Force-sync the LiteLLM model catalog from the gateway.",
      input: EMPTY_INPUT,
      async execute() {
        return { content: await models() };
      }
    },
    {
      name: "actsis_litellm_usage",
      description: "Show per-model usage from the LiteLLM gateway (spend, tokens, requests) for a window; supports day counts and explicit date ranges.",
      input: USAGE_INPUT,
      async execute(input) {
        const args = typeof input.args === "string" ? input.args : void 0;
        return { content: await usage(args) };
      }
    },
    {
      name: "actsis_litellm_top",
      description: "Enable, disable, or toggle the Top-5 spend models TUI widget; persists the preference (on|off|toggle, omitted = toggle) and refreshes or clears the widget rows.",
      input: TOP_INPUT,
      async execute(input) {
        const args = typeof input.args === "string" ? input.args : void 0;
        return { content: await top(args) };
      }
    },
    {
      name: "actsis_litellm_logout",
      description: "Revoke LiteLLM credentials and clear local state.",
      input: EMPTY_INPUT,
      async execute() {
        return { content: await logout() };
      }
    }
  ];
}

// src/plugin.ts
var DEFAULT_PROVIDER_ID = "actsis-litellm";
var DEFAULT_CATALOG_TTL_MS2 = 15 * 60 * 1e3;
var DEFAULT_REQUEST_TIMEOUT_MS = 3e4;
var DEFAULT_PROVIDER_NAME = "Actsis LiteLLM";
var OPENAI_COMPATIBLE_PACKAGE = "@opencode/ai/providers/openai-compatible";
var TLS_BOOTSTRAP_ONCE_KEY = "actsis-litellm-plugin";
async function runTlsBootstrapOnce() {
  try {
    const outcome = await configureSystemCa({
      onceKey: TLS_BOOTSTRAP_ONCE_KEY,
      optOutEnv: process.env.ACTSIS_LITELLM_NO_SYSTEM_CA
    });
    if (outcome.kind === "failed" && outcome.reason) {
      console.warn(
        `[actsis-litellm] TLS system-CA bootstrap skipped: ${outcome.reason}`
      );
    }
  } catch {
  }
}
function makeCredentialReader(ctx, providerId) {
  return async () => {
    const conn = await ctx.integration.connection.active(providerId);
    if (!conn) return null;
    const cred = await ctx.integration.connection.resolve(conn);
    return cred ?? null;
  };
}
function normalizeRawOptions(options) {
  if (!options || typeof options !== "object") {
    return {};
  }
  return {
    url: typeof options.url === "string" ? options.url : void 0,
    providerId: typeof options.providerId === "string" ? options.providerId : void 0,
    catalogTtlMinutes: typeof options.catalogTtlMinutes === "number" ? options.catalogTtlMinutes : void 0,
    requestTimeoutMs: typeof options.requestTimeoutMs === "number" ? options.requestTimeoutMs : void 0
  };
}
function resolveProviderId(options) {
  const id = options?.providerId?.trim();
  return id || DEFAULT_PROVIDER_ID;
}
function resolveStateDir() {
  return process.env.ACTSIS_LITELLM_STATE_DIR;
}
async function resolveClosure(options, authPath = defaultAuthPath(), stateDir = resolveStateDir()) {
  const pluginOptions = normalizeRawOptions(options);
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
function buildProviderInfo(closure) {
  return {
    ...ProviderSchema.Info.empty(closure.providerId),
    name: DEFAULT_PROVIDER_NAME,
    activation: "enabled",
    package: OPENAI_COMPATIBLE_PACKAGE,
    settings: {
      baseURL: closure.baseUrl ? `${closure.baseUrl}/v1` : ""
    },
    integrationID: closure.providerId
  };
}
function mapModelConfigToInfo(providerId, modelId, config) {
  const info = {
    ...ModelSchema.Info.default(
      providerId,
      modelId
    )
  };
  info.name = config.name || modelId;
  info.limit = {
    context: config.limit.context,
    output: config.limit.output
  };
  info.capabilities = {
    tools: config.tool_call,
    input: config.modalities.input,
    output: config.modalities.output
  };
  const tierCosts = config.cost?.tiers ?? [];
  const costs = [
    {
      input: config.cost?.input ?? 0,
      output: config.cost?.output ?? 0,
      cache: {
        read: config.cost?.cache_read ?? 0,
        write: config.cost?.cache_write ?? 0
      }
    }
  ];
  for (const tier of tierCosts) {
    costs.push({
      tier: { type: "context", size: tier.tier.size },
      input: tier.input,
      output: tier.output,
      cache: {
        read: tier.cache.read,
        write: tier.cache.write
      }
    });
  }
  info.cost = costs;
  const variants = Object.entries(config.variants ?? {}).map(([id, variant]) => ({
    id,
    settings: { reasoningEffort: variant.reasoningEffort }
  }));
  info.variants = variants;
  return info;
}
function buildCommandDefinitions(existing) {
  const defined = new Set(existing?.map((c) => c.name) ?? []);
  const all = [
    {
      name: "actsis-litellm-status",
      description: "Show LiteLLM gateway status and model cache state.",
      template: "Use the actsis_litellm_status tool, then summarize its result for the user."
    },
    {
      name: "actsis-litellm-models",
      description: "Force-sync the LiteLLM model catalog and show changes.",
      template: "Use the actsis_litellm_models tool, then summarize its result for the user."
    },
    {
      name: "actsis-litellm-budget",
      description: "Force a budget refresh and report the exact outcome.",
      template: "Use the actsis_litellm_budget tool, then summarize its result for the user."
    },
    {
      name: "actsis-litellm-usage",
      description: "Show per-model usage (spend/tokens/requests); args: [days] or 'YYYY-MM-DD .. YYYY-MM-DD'",
      template: "Use the actsis_litellm_usage tool, passing any window argument the user gave (a day count like 14, or a range like 2025-03-01 .. 2025-03-31) as its args input; omit args for the default last 30 days. Then summarize its result for the user."
    },
    {
      name: "actsis-litellm-top",
      description: "Enable, disable or toggle the Top-5 spend widget (args: on | off | toggle; omit to toggle).",
      template: "Use the actsis_litellm_top tool, passing exactly one of the words on, off or toggle as its args input when the user asked for a specific action; omit args to toggle the current state. Then summarize its result for the user."
    },
    {
      name: "actsis-litellm-logout",
      description: "Revoke LiteLLM credentials and clear local state.",
      template: "Use the actsis_litellm_logout tool, then summarize its result for the user."
    }
  ];
  return all.filter((command) => !defined.has(command.name));
}
function normalizeThinkingOption(options) {
  const thinking = options.thinking;
  if (typeof thinking === "string") {
    const lower = thinking.toLowerCase();
    options.thinking = lower === "off" || lower === "disabled" ? { type: "disabled" } : { type: "adaptive" };
    return;
  }
  if (typeof thinking === "object" && thinking !== null) {
    const type = thinking.type;
    if (type !== "disabled" && type !== "adaptive") {
      options.thinking = { type: "adaptive" };
    }
  }
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
      if (isOverflowErrorMessage(text) || lower.includes("context_length_exceeded")) {
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
function gatewayUrlField() {
  return {
    type: "string",
    key: "gatewayUrl",
    title: "Gateway base URL",
    description: "ACTSIS LiteLLM gateway base URL (https://...). Press Enter to use the configured one.",
    placeholder: "https://your-gateway.example.com",
    required: true,
    format: "uri"
  };
}
async function resolveGatewayUrlForAuth(answer, closure) {
  const fromAnswer = typeof answer?.gatewayUrl === "string" ? answer.gatewayUrl.trim() : "";
  if (fromAnswer) {
    return normalizeBaseUrl(fromAnswer);
  }
  if (closure.baseUrl) {
    return closure.baseUrl;
  }
  throw new ConfigError(
    "Gateway URL not configured. Provide it during login or set ACTSIS_LITELLM_URL / plugin options."
  );
}
function buildApiKeyMethodRegistration(closure) {
  return {
    integrationID: closure.providerId,
    method: {
      type: "key",
      label: "Use an API key",
      form: [gatewayUrlField()]
    }
  };
}
function buildOAuthMethodRegistration(closure) {
  return buildAuthMethodRegistrations(closure).oauth;
}
var OAUTH_METHOD_ID = "sso-browser";
var OAUTH_METHOD_BRANDED_ID = OAUTH_METHOD_ID;
function buildAuthMethodRegistrations(closure) {
  const oauth = {
    integrationID: closure.providerId,
    method: {
      id: OAUTH_METHOD_ID,
      type: "oauth",
      label: "Sign in with OAuth (browser)",
      form: [gatewayUrlField()]
    },
    async authorize(answer) {
      const baseUrl = await resolveGatewayUrlForAuth(
        answer,
        closure
      );
      let schemeUpgraded = false;
      const discovery = await fetchCliAuthDiscovery(
        baseUrl,
        closure.requestTimeoutMs,
        () => {
          schemeUpgraded = true;
        }
      );
      const flow = await runLoginFlow(
        { requestTimeoutMs: closure.requestTimeoutMs, stateDir: closure.stateDir },
        discovery,
        { schemeUpgraded }
      );
      const authorization = {
        url: flow.url,
        instructions: flow.instructions,
        mode: "auto",
        callback: (async () => {
          const result = await flow.callback();
          if (result.type !== "success") {
            throw new ConfigError("SSO login did not complete. Run the login flow again.");
          }
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
          return {
            type: "oauth",
            methodID: OAUTH_METHOD_BRANDED_ID,
            refresh: result.refresh,
            access: result.access,
            expires: result.expires,
            metadata: {
              userId: result.userId,
              teamId: result.teamId
            }
          };
        })()
      };
      return authorization;
    },
    async refresh(credential) {
      const next = await ensureFreshToken(
        { access: credential.access, refresh: credential.refresh, expires: credential.expires },
        {
          state: await readPluginState(closure.stateDir),
          timeoutMs: closure.requestTimeoutMs
        }
      );
      return {
        type: "oauth",
        methodID: credential.methodID,
        refresh: credential.refresh,
        access: next,
        expires: credential.expires,
        metadata: credential.metadata
      };
    },
    label(credential) {
      if (credential.metadata && typeof credential.metadata === "object") {
        const userId = credential.metadata.userId;
        if (typeof userId === "string" && userId) return userId;
      }
      return void 0;
    }
  };
  const apiKey = buildApiKeyMethodRegistration(closure);
  return { oauth, apiKey };
}
async function runBudgetRefresh(closure, getCredential) {
  try {
    const state = await readPluginState(closure.stateDir);
    const entry = await credentialEntry(closure, getCredential);
    if (!state?.gatewayUrl || !entry) return;
    const token = entry.type === "oauth" ? await ensureFreshToken(
      { access: entry.access, refresh: entry.refresh, expires: entry.expires },
      {
        state,
        timeoutMs: closure.requestTimeoutMs
      }
    ) : entry.key;
    const snapshot = await fetchGatewayBudget(state.gatewayUrl, token, closure.requestTimeoutMs);
    await updatePluginState(
      { lastBudgetSnapshot: snapshot, budgetRefreshedAt: Date.now() },
      closure.stateDir
    );
  } catch {
  }
  try {
    await runTopModelsRefresh(closure, getCredential);
  } catch {
  }
}
async function runTopModelsRefresh(closure, getCredential) {
  const enabled = await readTopModelsWidgetEnabled(closure.stateDir);
  if (!enabled) {
    const state2 = await readPluginState(closure.stateDir);
    if (state2?.lastTopModels?.length) {
      await updatePluginState(
        { lastTopModels: [], topRefreshedAt: void 0 },
        closure.stateDir
      );
    }
    return;
  }
  const state = await readPluginState(closure.stateDir);
  if (!state?.gatewayUrl) return;
  const entry = await credentialEntry(closure, getCredential);
  if (!entry) return;
  const now = Date.now();
  if (typeof state.topRefreshedAt === "number" && Number.isFinite(state.topRefreshedAt) && now - state.topRefreshedAt < TOP_MODELS_TTL_MS) {
    return;
  }
  const token = entry.type === "oauth" ? await ensureFreshToken(
    { access: entry.access, refresh: entry.refresh, expires: entry.expires },
    {
      state,
      timeoutMs: closure.requestTimeoutMs
    }
  ) : entry.key;
  let userId;
  if (getCredential) {
    try {
      userId = extractCredentialUserId(await getCredential()) ?? void 0;
    } catch {
      userId = void 0;
    }
  }
  const summary = await fetchModelUsage(
    state.gatewayUrl,
    token,
    closure.requestTimeoutMs,
    resolveUsageRangeDays(TOP_MODELS_WINDOW_DAYS, now),
    { userId }
  );
  if (summary.models.length === 0 || (summary.totals.spend ?? 0) <= 0) {
    await updatePluginState(
      { lastTopModels: [], topRefreshedAt: void 0 },
      closure.stateDir
    );
    return;
  }
  const cached = await loadCachedModels(closure.stateDir);
  const publicIds = cached ? Object.keys(cached) : [];
  const aliased = applyModelAliases(
    summary,
    mapModelAliases(
      summary.models.map((m) => m.model),
      publicIds
    )
  );
  await updatePluginState(
    {
      lastTopModels: aliased.models.slice(0, TOP_MODELS_ROW_LIMIT).map((m) => ({ model: m.model, spend: m.spend ?? 0 })),
      topRefreshedAt: now,
      topWindowLabel: TOP_WIDGET_WINDOW_LABEL,
      topTotalSpend: aliased.totals.spend ?? 0
    },
    closure.stateDir
  );
}
async function credentialEntry(closure, getCredential) {
  if (getCredential) {
    try {
      const cred = await getCredential();
      if (cred) {
        if (cred.type === "oauth" && typeof cred.access === "string" && cred.access) {
          return {
            type: "oauth",
            access: cred.access,
            refresh: typeof cred.refresh === "string" ? cred.refresh : "",
            expires: typeof cred.expires === "number" ? cred.expires : 0
          };
        }
        if (cred.type === "key" && typeof cred.key === "string" && cred.key) {
          return { type: "api", key: cred.key };
        }
      }
    } catch {
    }
  }
  return readAuthEntry(closure.authPath, closure.providerId);
}
async function buildInitialModels(closure, getCredential) {
  const entry = await credentialEntry(closure, getCredential);
  const token = entry?.type === "oauth" ? entry.access : entry?.type === "api" ? entry.key : void 0;
  const state = await readPluginState(closure.stateDir);
  const baseUrl = closure.baseUrl ?? (state?.gatewayUrl ? normalizeBaseUrl(state.gatewayUrl) : null);
  const toRecord = (models) => {
    const record = {};
    for (const [id, config] of Object.entries(models)) {
      record[id] = mapModelConfigToInfo(closure.providerId, id, config);
    }
    return record;
  };
  const cached = await loadCachedModels(closure.stateDir);
  const cachedRecord = cached ?? {};
  if (token && baseUrl) {
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
      const record = { ...cachedRecord };
      for (const model of fresh) {
        record[model.name] = model;
      }
      await saveCachedModels(record, closure.stateDir);
      return toRecord(record);
    } catch {
      return toRecord(cachedRecord);
    }
  }
  return toRecord(cachedRecord);
}
var plugin_default = Plugin.define({
  id: DEFAULT_PROVIDER_ID,
  async setup(ctx) {
    const context = ctx;
    const closure = await resolveClosure(
      context.options,
      defaultAuthPath(),
      resolveStateDir()
    );
    const getCredential = makeCredentialReader(context, closure.providerId);
    await runTlsBootstrapOnce();
    await context.integration.transform((editor) => {
      const { oauth, apiKey } = buildAuthMethodRegistrations(closure);
      editor.method.update(oauth);
      editor.method.update(apiKey);
    });
    const providerInfo = buildProviderInfo(closure);
    const initialModels = await buildInitialModels(closure, getCredential);
    await context.provider.transform((editor) => {
      editor.add({
        info: providerInfo,
        models: Object.values(initialModels)
      });
    });
    await context.tool.transform((editor) => {
      const toolDeps = {
        providerId: closure.providerId,
        stateDir: closure.stateDir,
        authPath: closure.authPath,
        getCredential
      };
      for (const info of buildLitellmToolInfos(toolDeps)) {
        editor.add(info);
      }
    });
    await context.command.transform((editor) => {
      for (const command of buildCommandDefinitions()) {
        editor.add({
          name: command.name,
          description: command.description,
          execute: async ({ sessionID, delivery }) => {
            await context.session.prompt({
              sessionID,
              text: command.template,
              ...delivery !== void 0 ? { delivery } : {}
            });
          }
        });
      }
    });
    await context.session.hook(
      "model.request",
      (event) => {
        const ev = event;
        const headers = ev.headers;
        if (headers && ev.sessionID) {
          headers["X-Litellm-Session-ID"] = ev.sessionID;
        }
      },
      { providerID: closure.providerId }
    );
    await context.session.hook(
      "context",
      (event) => {
        const ev = event;
        if (ev.options) {
          normalizeThinkingOption(ev.options);
        }
      },
      { providerID: closure.providerId }
    );
    await context.session.hook(
      "http.response",
      (event) => {
        const ev = event;
        const response = ev.response;
        if (!response) return;
        void Promise.resolve(response.clone().text().catch(() => "")).then((text) => {
          if (!text) return;
          if (isOverflowErrorMessage(text)) {
            console.warn(
              `[actsis-litellm] context overflow on model ${ev.model?.modelID ?? "unknown"}: ${text.slice(0, 300)}`
            );
            return;
          }
          const info = parseLimitError(text);
          if (info?.kind === "budget_exceeded") {
            console.warn(`[actsis-litellm] budget warning: ${formatBudgetWarning(info)}`);
          } else if (info?.kind === "throttling_error") {
            console.warn(`[actsis-litellm] throttle warning: ${formatThrottleWarning(info)}`);
          }
        }).catch(() => {
        });
      },
      { providerID: closure.providerId }
    );
    const controller = new AbortController();
    const eventLoop = (async () => {
      try {
        for await (const event of context.event.subscribe({ signal: controller.signal })) {
          if (event.type !== "session.idle") continue;
          try {
            await runBudgetRefresh(closure, getCredential);
          } catch {
          }
        }
      } catch {
      }
    })();
    void eventLoop;
    return async () => {
      controller.abort();
    };
  }
});
export {
  DEFAULT_PROVIDER_ID,
  buildApiKeyMethodRegistration,
  buildAuthMethodRegistrations,
  buildCommandDefinitions,
  buildInitialModels,
  buildLitellmToolInfos,
  buildOAuthMethodRegistration,
  buildProviderInfo,
  plugin_default as default,
  makeAuthFetch,
  mapModelConfigToInfo,
  normalizeThinkingOption,
  resolveClosure,
  resolveToolToken,
  runBudgetRefresh
};

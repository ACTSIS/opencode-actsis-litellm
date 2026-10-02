import { readPluginState, writePluginState, updatePluginState, type PluginState } from "./state.ts";
import {
  loadCachedModels,
  saveCachedModels,
  computeCacheAge,
  type OpencodeModelConfig,
} from "./catalog-cache.ts";
import { fetchCatalogModels } from "./catalog.ts";
import { fetchGatewayBudget, formatBudgetLine, formatBudgetStatus } from "./budget.ts";
import { readAuthEntry, clearAuthEntry, defaultAuthPath, type AuthJsonEntry } from "./auth-store.ts";
import { revokeToken, type CliAuthDiscovery } from "./client.ts";
import { AuthError } from "./errors.ts";
import { discoveryFromState, ensureFreshToken } from "./gateway-client.ts";
import path from "node:path";
import os from "node:os";
import { rm } from "node:fs/promises";

const DEFAULT_PLUGIN_DIR_NAME = "actsis-litellm";
const DEFAULT_APP_DIR_NAME = "opencode";
const DEFAULT_TIMEOUT_MS = 30_000;
const CACHE_FILE_NAME = "models-cache.json";

function defaultPluginDir(): string {
  const dataHome = process.env.XDG_DATA_HOME
    ? process.env.XDG_DATA_HOME
    : path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, DEFAULT_APP_DIR_NAME, DEFAULT_PLUGIN_DIR_NAME);
}

function cachePath(dir?: string): string {
  return path.join(dir ?? defaultPluginDir(), CACHE_FILE_NAME);
}

function formatExpiry(entry: AuthJsonEntry | null): string {
  if (!entry) return "never";
  if (entry.type === "api") return "never";
  if (!Number.isFinite(entry.expires)) return "never";
  return new Date(entry.expires).toISOString();
}

/**
 * Structural view of a v2 integration credential, matching @opencode/schema's
 * `Credential.Value` ({type:"oauth", methodID, refresh, access, expires} |
 * {type:"key", key}). Kept structural so tests and tool code never import
 * OpenCode runtime internals.
 */
export interface StructuralCredential {
  type: "oauth" | "key";
  methodID?: string;
  refresh?: string;
  access?: string;
  expires?: number;
  key?: string;
}

export interface ToolDeps {
  providerId: string;
  stateDir?: string;
  authPath?: string;
  fetchImpl?: typeof fetch;
  timeout?: number;
  /**
   * Optional v2 integration credential reader (wired by the server plugin
   * from `ctx.integration.connection.active` + `resolve`). Tried FIRST by
   * every tool; `readAuthEntry` (v1 auth.json) is only a fallback for v1-era
   * state when this reader is absent or returns null.
   */
  getCredential?: () => Promise<StructuralCredential | null>;
  /**
   * Optional v2 credential persistence hook (wired by the server plugin).
   * When OpenCode's integration refresh callback persists rotated tokens,
   * the tools surface the same callback so gateway reads stay consistent.
   */
  onRefreshed?: (next: { access: string; refresh: string; expires: number }) => Promise<void>;
}

/**
 * v2 tool shape (Tool.Info from @opencode/schema/tool): JSON Schema input,
 * an execute returning Tool.Result ({content}), no v1 `args` helper.
 */
export interface ToolInfo {
  name: string;
  description: string;
  input: { type: "object"; properties: Record<string, never>; additionalProperties: false };
  execute: (input: Record<string, unknown>, context: unknown) => Promise<{ content: string }>;
}

const EMPTY_INPUT = { type: "object" as const, properties: {}, additionalProperties: false as const };

/**
 * Resolve the gateway state and a bearer token for tool requests.
 *
 * In v2 the OAuth refresh token is owned by the integration credential flow;
 * tools only call `ensureFreshToken` to obtain a current access token for
 * their own gateway reads and do not persist rotated tokens themselves
 * (the integration `refresh` callback handles that when OpenCode invokes it).
 */
export async function resolveToolToken(
  deps: ToolDeps,
): Promise<{ state: PluginState | null; entry: AuthJsonEntry | null; token: string | null }> {
  const {
    providerId,
    stateDir,
    authPath = defaultAuthPath(),
    fetchImpl,
    timeout = DEFAULT_TIMEOUT_MS,
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
      fetchImpl,
    },
  );
  return { state, entry, token: token || null };
}

/**
 * Resolve the current credential for tool runs: the v2 integration reader
 * first, the v1 auth.json file as fallback (v1-era installations).
 */
export async function readEntry(deps: ToolDeps): Promise<AuthJsonEntry | null> {
  if (deps.getCredential) {
    try {
      const cred = await deps.getCredential();
      if (cred) {
        const normalized = normalizeCredential(cred);
        if (normalized) return normalized;
      }
    } catch {
      // Integration reader failure falls through to the v1 file fallback.
    }
  }
  return readAuthEntry(deps.authPath ?? defaultAuthPath(), deps.providerId);
}

function normalizeCredential(cred: StructuralCredential): AuthJsonEntry | null {
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

export function buildLitellmToolInfos(deps: ToolDeps): ToolInfo[] {
  const {
    providerId,
    stateDir,
    authPath = defaultAuthPath(),
    fetchImpl = globalThis.fetch,
    timeout = DEFAULT_TIMEOUT_MS,
    onRefreshed,
  } = deps;

  const status = async (): Promise<string> => {
    const state = await readPluginState(stateDir);
    const entry = await readEntry(deps);
    const cached = await loadCachedModels(stateDir);
    const age = await computeCacheAge(stateDir);
    const gatewayUrl = state?.gatewayUrl ?? "not configured";

    const ageText = age === null ? "none" : `${Math.floor(age / 60_000)}m ago`;
    const cacheCount = cached ? Object.keys(cached).length : 0;

    const authType = entry?.type ?? "none";
    const authExpiry = formatExpiry(entry);

    let budgetLines = ["Budget: unavailable"];
    try {
      if (entry && state?.gatewayUrl) {
        const token = entry.type === "oauth"
          ? await ensureFreshToken(
            { access: entry.access, refresh: entry.refresh, expires: entry.expires },
            {
              state,
              timeoutMs: timeout,
              fetchImpl,
              onRefreshed,
            },
          )
          : entry.key;
        const snapshot = await fetchGatewayBudget(state.gatewayUrl, token, timeout, fetchImpl);
        await updatePluginState(
          { lastBudgetSnapshot: snapshot, budgetRefreshedAt: Date.now() },
          stateDir,
        );
        const primary = formatBudgetLine(snapshot.primary);
        if (primary) {
          budgetLines = [`Budget: ${primary}`];
          if (snapshot.source === "user_info") {
            for (const key of snapshot.ownKeys) {
              const keyLine = formatBudgetLine(key);
              if (keyLine) {
                budgetLines.push(
                  key.keyAlias ? `Key ${key.keyAlias}: ${keyLine}` : `Key: ${keyLine}`,
                );
              }
            }
          }
        }
      }
    } catch (err) {
      if (err instanceof AuthError) {
        budgetLines = ["Budget: Credential rejected — run /login again"];
      } else {
        const reason = err instanceof Error ? err.message : String(err);
        const cachedSnapshot = state?.lastBudgetSnapshot;
        const cachedAt = state?.budgetRefreshedAt;
        const cachedLine =
          cachedSnapshot && typeof cachedAt === "number"
            ? formatBudgetLine(cachedSnapshot.primary)
            : null;
        const cachedAgeSeconds =
          cachedSnapshot && typeof cachedAt === "number"
            ? Math.max(0, Math.floor((Date.now() - cachedAt) / 1000))
            : null;
        budgetLines = [
          `Budget unavailable: ${reason}`,
          ...(cachedLine && cachedAgeSeconds !== null
            ? [`Budget (cached ${cachedAgeSeconds}s ago): ${cachedLine}`]
            : []),
        ];
      }
    }

    const lines = [
      `Provider: ${providerId}`,
      `Auth: ${authType} (expires ${authExpiry})`,
      `Catalog: ${cacheCount} models cached (age ${ageText})`,
      `Gateway URL: ${gatewayUrl}`,
      ...budgetLines,
    ];

    return lines.join("\n");
  };

  const budget = async (): Promise<string> => {
    const state = await readPluginState(stateDir);
    const entry = await readEntry(deps);

    if (!state || !entry) {
      return "no credential stored — run /login";
    }
    if (!state.gatewayUrl) {
      return "gateway URL not configured";
    }

    try {
      const token = entry.type === "oauth"
        ? await ensureFreshToken(
          { access: entry.access, refresh: entry.refresh, expires: entry.expires },
          {
            state,
            timeoutMs: timeout,
            fetchImpl,
            onRefreshed,
          },
        )
        : entry.key;
      const snapshot = await fetchGatewayBudget(state.gatewayUrl, token, timeout, fetchImpl);
      await updatePluginState(
        { lastBudgetSnapshot: snapshot, budgetRefreshedAt: Date.now() },
        stateDir,
      );
      const text = formatBudgetStatus(snapshot.primary);
      return text ?? "no spend data (spend null)";
    } catch (err) {
      if (err instanceof AuthError) {
        return err.message;
      }
      const reason = err instanceof Error ? err.message : String(err);
      const cachedLine = state.lastBudgetSnapshot && state.budgetRefreshedAt
        ? formatBudgetLine(state.lastBudgetSnapshot.primary)
        : null;
      return `error: ${reason}${cachedLine ? ` (last known: ${cachedLine})` : ""}`;
    }
  };

  const models = async (): Promise<string> => {
    const entry = await readEntry(deps);
    if (!entry) {
      return "Not signed in — run /login and choose ACTSIS LiteLLM.";
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
        requestTimeoutMs: timeout,
      },
      token,
      undefined,
      fetchImpl,
    );

    const record: Record<string, OpencodeModelConfig> = {};
    for (const model of fresh) {
      record[model.name] = model;
    }
    await saveCachedModels(record, stateDir);

    const currentIds = Object.keys(record);
    const added = currentIds.filter((id) => !previousSet.has(id)).length;
    const removed = previousIds.filter((id) => !record[id]).length;

    return `Model catalog synced: ${currentIds.length} models available (added ${added}, removed ${removed}). Restart OpenCode to see new models in the picker.`;
  };

  const logout = async (): Promise<string> => {
    const state = await readPluginState(stateDir);
    const entry = await readEntry(deps);

    if (entry?.type === "oauth" && entry.refresh && state?.tokenEndpoint && state?.clientId) {
      try {
        await revokeToken(
          discoveryFromState(state),
          { token: entry.refresh, clientId: state.clientId },
          timeout,
          fetchImpl,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.toLowerCase().includes("fetch")) {
          // Best-effort: network failure means the token will expire locally.
        }
      }
    }

    await clearAuthEntry(authPath, providerId);
    await writePluginState({ version: 1 }, stateDir);

    try {
      await rm(cachePath(stateDir), { force: true });
    } catch {
      // Best-effort cache removal.
    }

    return [
      "Logged out. Local state and model cache cleared.",
      "OpenCode still holds the integration credential; disconnect it via the native auth UI — the plugin has no API to delete it.",
    ].join("\n");
  };

  return [
    {
      name: "actsis_litellm_status",
      description: "Show LiteLLM gateway status, credential state, and model cache age.",
      input: EMPTY_INPUT,
      async execute() {
        return { content: await status() };
      },
    },
    {
      name: "actsis_litellm_budget",
      description: "Force a budget refresh and report the exact outcome.",
      input: EMPTY_INPUT,
      async execute() {
        return { content: await budget() };
      },
    },
    {
      name: "actsis_litellm_models",
      description: "Force-sync the LiteLLM model catalog from the gateway.",
      input: EMPTY_INPUT,
      async execute() {
        return { content: await models() };
      },
    },
    {
      name: "actsis_litellm_logout",
      description: "Revoke LiteLLM credentials and clear local state.",
      input: EMPTY_INPUT,
      async execute() {
        return { content: await logout() };
      },
    },
  ];
}
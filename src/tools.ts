import { tool } from "@opencode-ai/plugin";
import { readPluginState, writePluginState, type PluginState } from "./state.ts";
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
import type { PluginInput, ToolDefinition } from "@opencode-ai/plugin";

const DEFAULT_PLUGIN_DIR_NAME = "actsis-litellm";
const DEFAULT_APP_DIR_NAME = "opencode";
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

export interface ToolDeps {
  providerId: string;
  getState: () => Promise<PluginState | null>;
  timeout: number;
  input: PluginInput;
  stateDir?: string;
  authPath?: string;
  fetchImpl?: typeof fetch;
}

export function buildLitellmTools(deps: ToolDeps): Record<string, ToolDefinition> {
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
                  onRefreshed: async (next) => {
                    await deps.input.client.auth.set({
                      path: { id: providerId },
                      body: { type: "oauth", ...next },
                    });
                  },
                },
              )
              : entry.key;
            const snapshot = await fetchGatewayBudget(state.gatewayUrl, token, timeout, fetchImpl);
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
          budgetLines = [`Budget: unavailable (${err instanceof Error ? err.message : String(err)})`];
        }

        const lines = [
          `Provider: ${providerId}`,
          `Auth: ${authType} (expires ${authExpiry})`,
          `Catalog: ${cacheCount} models cached (age ${ageText})`,
          `Gateway URL: ${gatewayUrl}`,
          ...budgetLines,
        ];

        return lines.join("\n");
      },
    }),

    actsis_litellm_budget: tool({
      description: "Force a budget refresh and report the exact outcome.",
      args: {},
      async execute(_args, _context) {
        const state = await readPluginState(stateDir);
        const entry = await readAuthEntry(authPath, providerId);

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
                onRefreshed: async (next) => {
                  await deps.input.client.auth.set({
                    path: { id: providerId },
                    body: { type: "oauth", ...next },
                  });
                },
              },
            )
            : entry.key;
          const snapshot = await fetchGatewayBudget(state.gatewayUrl, token, timeout, fetchImpl);
          const text = formatBudgetStatus(snapshot.primary);
          return text ?? "no spend data (spend null)";
        } catch (err) {
          if (err instanceof AuthError) {
            return err.message;
          }
          const reason = err instanceof Error ? err.message : String(err);
          return `error: ${reason}`;
        }
      },
    }),

    actsis_litellm_models: tool({
      description: "Force-sync the LiteLLM model catalog from the gateway.",
      args: {},
      async execute(_args, _context) {
        const entry = await readAuthEntry(authPath, providerId);
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
      },
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

        return "Logged out. Credentials revoked and local state cleared.";
      },
    }),
  };
}

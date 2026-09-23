import { fetchCliAuthDiscovery } from "./client.ts";
import { runLoginFlow } from "./oauth.ts";
import { readPluginState, updatePluginState, type PluginState } from "./state.ts";
import {
  loadCachedModels,
  saveCachedModels,
  computeCacheAge,
  type OpencodeModelConfig,
} from "./catalog-cache.ts";
import { fetchCatalogModels } from "./catalog.ts";
import { parseLimitError, formatBudgetWarning, formatThrottleWarning } from "./limit-errors.ts";
import { isOverflowErrorMessage } from "./overflow.ts";
import { readAuthEntry, clearAuthEntry, defaultAuthPath } from "./auth-store.ts";
import { resolveConfig, normalizeBaseUrl, type PluginOptions } from "./config.ts";
import { ConfigError } from "./errors.ts";
import { ensureFreshToken } from "./gateway-client.ts";
import { fetchGatewayBudget } from "./budget.ts";

import type { PluginInput, PluginOptions as OpenCodePluginOptions, Config, AuthOAuthResult } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";
import type { Auth } from "@opencode-ai/sdk/v2";
import type { Provider as ProviderV2, Model as ModelV2 } from "@opencode-ai/sdk/v2/types";

type OpenCodeConfig = Config;

const DEFAULT_PROVIDER_ID = "actsis-litellm";
const DEFAULT_CATALOG_TTL_MS = 15 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface PluginClosure {
  baseUrl: string | null;
  providerId: string;
  catalogTtlMs: number;
  requestTimeoutMs: number;
  authPath: string;
  stateDir: string | undefined;
}

function normalizeOptions(options?: OpenCodePluginOptions): PluginOptions {
  if (!options || typeof options !== "object") {
    return {};
  }
  const record = options as Record<string, unknown>;
  return {
    url: typeof record.url === "string" ? record.url : undefined,
    providerId: typeof record.providerId === "string" ? record.providerId : undefined,
    catalogTtlMinutes: typeof record.catalogTtlMinutes === "number" ? record.catalogTtlMinutes : undefined,
    requestTimeoutMs: typeof record.requestTimeoutMs === "number" ? record.requestTimeoutMs : undefined,
  };
}

function resolveProviderId(options?: PluginOptions): string {
  const id = options?.providerId?.trim();
  return id || DEFAULT_PROVIDER_ID;
}

export async function resolveClosure(
  input: PluginInput,
  options?: OpenCodePluginOptions,
  authPath: string = defaultAuthPath(),
  stateDir?: string,
): Promise<PluginClosure> {
  const pluginOptions = normalizeOptions(options);
  const providerId = resolveProviderId(pluginOptions);

  const envUrl = process.env.ACTSIS_LITELLM_URL?.trim();
  const storedUrl = (await readPluginState(stateDir))?.gatewayUrl;

  let baseUrl: string | null = null;
  if (envUrl) {
    baseUrl = normalizeBaseUrl(envUrl);
  } else if (pluginOptions.url) {
    baseUrl = normalizeBaseUrl(pluginOptions.url);
  } else if (storedUrl) {
    baseUrl = normalizeBaseUrl(storedUrl);
  }

  const catalogTtlMs =
    pluginOptions.catalogTtlMinutes !== undefined
      ? Math.max(0, pluginOptions.catalogTtlMinutes * 60 * 1000)
      : DEFAULT_CATALOG_TTL_MS;
  const requestTimeoutMs =
    pluginOptions.requestTimeoutMs !== undefined
      ? pluginOptions.requestTimeoutMs
      : DEFAULT_REQUEST_TIMEOUT_MS;

  return {
    baseUrl,
    providerId,
    catalogTtlMs,
    requestTimeoutMs,
    authPath,
    stateDir,
  };
}

export interface BuiltProviderConfig {
  npm: string;
  name: string;
  options: {
    baseURL: string;
    apiKey: string;
  };
  models: Record<string, OpencodeModelConfig>;
}

export function buildProviderInjection(
  config: OpenCodeConfig,
  params: {
    providerId: string;
    baseUrl: string | null;
    models: Record<string, OpencodeModelConfig>;
  },
): void {
  const existing = config.provider?.[params.providerId];
  const baseURL = params.baseUrl ? `${params.baseUrl}/v1` : "";

  const merged: BuiltProviderConfig = {
    npm: (existing as Partial<BuiltProviderConfig> | undefined)?.npm ?? "@ai-sdk/openai-compatible",
    name:
      (existing as Partial<BuiltProviderConfig> | undefined)?.name ?? "Actsis LiteLLM",
    options: {
      baseURL,
      apiKey: "",
      ...(existing as Partial<BuiltProviderConfig> | undefined)?.options,
    },
    models: {
      ...((existing as Partial<BuiltProviderConfig> | undefined)?.models ?? {}),
      ...params.models,
    },
  };

  if (!config.provider) {
    config.provider = {};
  }
  config.provider[params.providerId] = merged as unknown as NonNullable<OpenCodeConfig["provider"]>[string];
}

export function buildCommandTemplates(existing: Record<string, { template: string; description?: string }> | undefined): Record<string, { template: string; description: string }> {
  const commands: Record<string, { template: string; description: string }> = {};

  if (!existing?.["actsis-litellm-status"]) {
    commands["actsis-litellm-status"] = {
      template:
        "Use the actsis_litellm_status tool, then summarize its result for the user.",
      description: "Show LiteLLM gateway status and model cache state.",
    };
  }

  if (!existing?.["actsis-litellm-models"]) {
    commands["actsis-litellm-models"] = {
      template:
        "Use the actsis_litellm_models tool, then summarize its result for the user.",
      description: "Force-sync the LiteLLM model catalog and show changes.",
    };
  }

  if (!existing?.["actsis-litellm-budget"]) {
    commands["actsis-litellm-budget"] = {
      template:
        "Use the actsis_litellm_budget tool, then summarize its result for the user.",
      description: "Force a budget refresh and report the exact outcome.",
    };
  }

  if (!existing?.["actsis-litellm-logout"]) {
    commands["actsis-litellm-logout"] = {
      template:
        "Use the actsis_litellm_logout tool, then summarize its result for the user.",
      description: "Revoke LiteLLM credentials and clear local state.",
    };
  }

  return commands;
}

async function resolveGatewayUrlForAuth(
  inputs: Record<string, string> | undefined,
  closure: PluginClosure,
): Promise<string> {
  const fromInput = inputs?.gatewayUrl?.trim();
  if (fromInput) {
    return normalizeBaseUrl(fromInput);
  }
  if (closure.baseUrl) {
    return closure.baseUrl;
  }
  throw new ConfigError("Gateway URL not configured. Provide it during login or set ACTSIS_LITELLM_URL / plugin options.");
}

function makeGatewayUrlPrompt(closure: PluginClosure) {
  return {
    type: "text" as const,
    key: "gatewayUrl",
    message: "Gateway base URL (press Enter to use the configured one)",
    placeholder: "https://your-gateway.example.com",
    validate(value: string): string | undefined {
      const trimmed = value.trim();
      if (!trimmed) {
        if (closure.baseUrl) return undefined;
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
      return undefined;
    },
  };
}

function buildOAuthMethod(closure: PluginClosure): {
  type: "oauth";
  label: string;
  prompts: ReturnType<typeof makeGatewayUrlPrompt>[];
  authorize(inputs?: Record<string, string>): Promise<AuthOAuthResult>;
} {
  return {
    type: "oauth",
    label: "Sign in with SSO (browser)",
    prompts: [makeGatewayUrlPrompt(closure)],
    async authorize(inputs): Promise<AuthOAuthResult> {
      const baseUrl = await resolveGatewayUrlForAuth(inputs, closure);

      let schemeUpgraded = false;
      const discovery = await fetchCliAuthDiscovery(
        baseUrl,
        closure.requestTimeoutMs,
        () => {
          schemeUpgraded = true;
        },
      );

      const flow = await runLoginFlow(
        { requestTimeoutMs: closure.requestTimeoutMs },
        discovery,
        { schemeUpgraded },
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
                schemeUpgraded,
              },
              closure.stateDir,
            );
          }
          return result;
        } catch {
          return { type: "failed" } as const;
        }
      };

      return {
        ...flow,
        callback: wrappedCallback,
      };
    },
  };
}

function buildApiKeyMethod(closure: PluginClosure): {
  type: "api";
  label: string;
  prompts: Array<ReturnType<typeof makeGatewayUrlPrompt>>;
  authorize(inputs?: Record<string, string>): Promise<{ type: "success"; key?: string } | { type: "failed" }>;
} {
  return {
    type: "api",
    label: "Use an API key",
    prompts: [makeGatewayUrlPrompt(closure)],
    async authorize(inputs): Promise<{ type: "success"; key?: string } | { type: "failed" }> {
      try {
        const baseUrl = await resolveGatewayUrlForAuth(inputs, closure);

        await updatePluginState(
          {
            gatewayUrl: baseUrl,
            providerId: closure.providerId,
            authMode: "api_key",
            clientId: undefined,
            tokenEndpoint: undefined,
            revocationEndpoint: undefined,
            resource: undefined,
          },
          closure.stateDir,
        );

        // No `key` here: the OpenCode CLI prompts for the API key natively and
        // persists it in its credential store. It is never passed to the
        // plugin, and validation happens on first request.
        return { type: "success" };
      } catch {
        return { type: "failed" };
      }
    },
  };
}

export function makeAuthFetch(
  getToken: () => Promise<string>,
  fetchImpl: typeof fetch = globalThis.fetch,
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
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
      // Non-classified responses are returned unchanged.
      return response;
    }

    return response;
  };
}

export function buildAuthLoader(closure: PluginClosure, input: PluginInput) {
  return async function authLoader(
    getAuth: () => Promise<Auth>,
  ): Promise<Record<string, unknown>> {
    // Precedence: env > options URL (closure.baseUrl) > state file. The
    // closure already resolved that order; the state file only breaks ties
    // for a providerId mismatch so the login-time URL wins after login.
    const state = await readPluginState(closure.stateDir);
    const baseUrl =
      closure.baseUrl ??
      (state?.gatewayUrl && closure.providerId === state.providerId
        ? normalizeBaseUrl(state.gatewayUrl)
        : null);
    const baseURL = baseUrl ? `${baseUrl}/v1` : "";

    let current: Auth;
    try {
      current = await getAuth();
    } catch {
      return {};
    }

    if (current.type === "api") {
      return {
        apiKey: current.key,
        baseURL,
        fetch: makeAuthFetch(() => Promise.resolve(current.key)),
      };
    }

    if (current.type === "oauth") {
      const tokenProvider = async (): Promise<string> => {
        const cur = await getAuth();
        if (cur.type !== "oauth") {
          throw new Error("Not signed in to the LiteLLM gateway — run /login");
        }
        return ensureFreshToken(
          { access: cur.access, refresh: cur.refresh, expires: cur.expires },
          {
            state: await readPluginState(closure.stateDir),
            timeoutMs: closure.requestTimeoutMs,
            onRefreshed: async (next) => {
              await input.client.auth.set({
                path: { id: closure.providerId },
                body: { type: "oauth", ...next },
              });
            },
          },
        );
      };

      return {
        apiKey: "",
        baseURL,
        fetch: makeAuthFetch(tokenProvider),
      };
    }

    return {};
  };
}

export function buildProviderModels(closure: PluginClosure) {
  return async function providerModels(
    _provider: ProviderV2,
    ctx: { auth?: Auth },
  ): Promise<Record<string, ModelV2>> {
    let token: string | undefined;
    if (ctx.auth?.type === "oauth") {
      token = ctx.auth.access;
    } else if (ctx.auth?.type === "api") {
      token = ctx.auth.key;
    }

    const state = await readPluginState(closure.stateDir);
    // Same precedence as buildAuthLoader: env > options URL > state file.
    const baseUrl = closure.baseUrl ??
      (state?.gatewayUrl ? normalizeBaseUrl(state.gatewayUrl) : null);

    const cached = await loadCachedModels(closure.stateDir);
    if (cached && Object.keys(cached).length > 0) {
      const age = await computeCacheAge(closure.stateDir);
      if (age !== null && age < closure.catalogTtlMs) {
        return cached as unknown as Record<string, ModelV2>;
      }
    }

    if (!token || !baseUrl) {
      return (cached ?? {}) as unknown as Record<string, ModelV2>;
    }

    try {
      const fresh = await fetchCatalogModels(
        {
          baseUrl,
          providerId: closure.providerId,
          catalogTtlMs: closure.catalogTtlMs,
          requestTimeoutMs: closure.requestTimeoutMs,
        },
        token,
      );
      const record: Record<string, OpencodeModelConfig> = {};
      for (const model of fresh) {
        record[model.name] = model;
      }
      await saveCachedModels(record, closure.stateDir);
      return record as unknown as Record<string, ModelV2>;
    } catch {
      return (cached ?? {}) as unknown as Record<string, ModelV2>;
    }
  };
}

export default async function ActsisActiveLLMPlugin(
  input: PluginInput,
  options?: OpenCodePluginOptions,
): Promise<{
  config?: (config: OpenCodeConfig) => Promise<void>;
  auth?: {
    provider: string;
    loader: (getAuth: () => Promise<Auth>) => Promise<Record<string, unknown>>;
    methods: Array<{ type: "oauth" | "api"; label: string } & Record<string, unknown>>;
  };
  provider?: {
    id: string;
    models: (provider: ProviderV2, ctx: { auth?: Auth }) => Promise<Record<string, ModelV2>>;
  };
  tool?: Record<string, unknown>;
  "chat.headers"?: (input: { sessionID: string; model?: { providerID: string; modelID: string } }, output: { headers: Record<string, string> }) => Promise<void>;
  "chat.params"?: (input: { model?: { providerID: string; modelID: string } }, output: { options: Record<string, unknown> }) => Promise<void>;
  event?: (input: { event: Event }) => Promise<void>;
}> {
  const closure = await resolveClosure(
    input,
    options,
    defaultAuthPath(),
    process.env.ACTSIS_LITELLM_STATE_DIR,
  );

  const hooks: Awaited<ReturnType<typeof ActsisActiveLLMPlugin>> = {
    config: undefined,
    auth: undefined,
    provider: undefined,
    tool: undefined,
    "chat.headers": undefined,
    "chat.params": undefined,
    event: undefined,
  };

  hooks.config = async (config: OpenCodeConfig): Promise<void> => {
    const token = readAuthEntry(closure.authPath, closure.providerId)?.then((entry) => {
      if (entry?.type === "oauth") return entry.access;
      if (entry?.type === "api") return entry.key;
      return undefined;
    });

    let models: Record<string, OpencodeModelConfig> = {};
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
            requestTimeoutMs: closure.requestTimeoutMs,
          },
          resolvedToken,
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
      models,
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
    methods: [buildOAuthMethod(closure) as unknown as ReturnType<typeof buildOAuthMethod> & Record<string, unknown>, buildApiKeyMethod(closure) as unknown as ReturnType<typeof buildApiKeyMethod> & Record<string, unknown>],
  };

  hooks.provider = {
    id: closure.providerId,
    models: buildProviderModels(closure),
  };

  hooks.tool = {}; // will be populated from tools.ts wiring

  hooks["chat.headers"] = async (
    hookInput: { sessionID: string; model?: { providerID: string; modelID: string } },
    output: { headers: Record<string, string> },
  ): Promise<void> => {
    if (hookInput.model?.providerID === closure.providerId && hookInput.sessionID) {
      output.headers["X-Litellm-Session-ID"] = hookInput.sessionID;
    }
  };

  hooks["chat.params"] = async (
    hookInput: { model?: { providerID: string; modelID: string } },
    output: { options: Record<string, unknown> },
  ): Promise<void> => {
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
      const type = (thinking as { type?: unknown }).type;
      if (type !== "disabled" && type !== "adaptive") {
        output.options.thinking = { type: "adaptive" };
      }
    }
  };

  // session.idle fires at the end of an agent turn (pi's `agent_end` parity):
  // refresh the stored budget snapshot in the background.
  hooks.event = async ({ event }: { event: Event }): Promise<void> => {
    if (event.type !== "session.idle") return;
    try {
      const state = await readPluginState(closure.stateDir);
      const entry = await readAuthEntry(closure.authPath, closure.providerId);
      if (!state?.gatewayUrl || !entry) return;
      const token = entry.type === "oauth"
        ? await ensureFreshToken(
          { access: entry.access, refresh: entry.refresh, expires: entry.expires },
          {
            state,
            timeoutMs: closure.requestTimeoutMs,
            onRefreshed: async (next) => {
              await input.client.auth.set({
                path: { id: closure.providerId },
                body: { type: "oauth", ...next },
              });
            },
          },
        )
        : entry.key;
      const snapshot = await fetchGatewayBudget(state.gatewayUrl, token, closure.requestTimeoutMs);
      await updatePluginState(
        { lastBudgetSnapshot: snapshot, budgetRefreshedAt: Date.now() },
        closure.stateDir,
      );
    } catch {
      // Background refresh: failures are silent; tools force a fresh fetch.
    }
  };

  return hooks;
}

export { ActsisActiveLLMPlugin };

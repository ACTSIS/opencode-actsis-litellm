import { Plugin, Credential, Provider as ProviderSchema, Model as ModelSchema } from "@opencode/plugin";
import { Form } from "@opencode/schema/form";
import { Integration as IntegrationSchema } from "@opencode/schema/integration";
import {
  fetchCliAuthDiscovery,
} from "./client.ts";
import { runLoginFlow } from "./oauth.ts";
import { readPluginState, updatePluginState } from "./state.ts";
import {
  loadCachedModels,
  saveCachedModels,
  computeCacheAge,
  type OpencodeModelConfig,
} from "./catalog-cache.ts";
import { fetchCatalogModels } from "./catalog.ts";
import { parseLimitError, formatBudgetWarning, formatThrottleWarning } from "./limit-errors.ts";
import { isOverflowErrorMessage } from "./overflow.ts";
import { readAuthEntry, defaultAuthPath } from "./auth-store.ts";
import { normalizeBaseUrl, type PluginOptions } from "./config.ts";
import { ConfigError } from "./errors.ts";
import { ensureFreshToken } from "./gateway-client.ts";
import { fetchGatewayBudget } from "./budget.ts";
import { buildLitellmToolInfos, type ToolDeps } from "./tools.ts";

const DEFAULT_PROVIDER_ID = "actsis-litellm";
export { DEFAULT_PROVIDER_ID };
const DEFAULT_CATALOG_TTL_MS = 15 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_PROVIDER_NAME = "Actsis LiteLLM";
const OPENAI_COMPATIBLE_PACKAGE = "@opencode/ai/providers/openai-compatible";

export interface PluginClosure {
  baseUrl: string | null;
  providerId: string;
  catalogTtlMs: number;
  requestTimeoutMs: number;
  authPath: string;
  stateDir: string | undefined;
}

function normalizeRawOptions(options?: Record<string, unknown>): PluginOptions {
  if (!options || typeof options !== "object") {
    return {};
  }
  return {
    url: typeof options.url === "string" ? options.url : undefined,
    providerId: typeof options.providerId === "string" ? options.providerId : undefined,
    catalogTtlMinutes: typeof options.catalogTtlMinutes === "number" ? options.catalogTtlMinutes : undefined,
    requestTimeoutMs: typeof options.requestTimeoutMs === "number" ? options.requestTimeoutMs : undefined,
  };
}

function resolveProviderId(options?: PluginOptions): string {
  const id = options?.providerId?.trim();
  return id || DEFAULT_PROVIDER_ID;
}

function resolveStateDir(): string | undefined {
  return process.env.ACTSIS_LITELLM_STATE_DIR;
}

export async function resolveClosure(
  options?: Record<string, unknown>,
  authPath: string = defaultAuthPath(),
  stateDir: string | undefined = resolveStateDir(),
): Promise<PluginClosure> {
  const pluginOptions = normalizeRawOptions(options);
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

/**
 * Build the v2 Provider.Info for the gateway, bound to the integration whose
 * credentials supply the bearer token / API key.
 */
export function buildProviderInfo(closure: PluginClosure) {
  return {
    ...ProviderSchema.Info.empty(closure.providerId as ProviderSchema.ID),
    name: DEFAULT_PROVIDER_NAME,
    activation: "enabled" as const,
    package: OPENAI_COMPATIBLE_PACKAGE,
    settings: {
      baseURL: closure.baseUrl ? `${closure.baseUrl}/v1` : "",
    },
    integrationID: closure.providerId,
  };
}

/**
 * Map one catalog entry onto a v2 Model.Info: start from Model.Info.default
 * and override with gateway-reported catalog values.
 */
export function mapModelConfigToInfo(
  providerId: string,
  modelId: string,
  config: OpencodeModelConfig,
): ModelSchema.Info {
  const info = {
    ...ModelSchema.Info.default(
      providerId as ProviderSchema.ID,
      modelId as ModelSchema.ID,
    ),
  } as Record<string, unknown>;
  // Model.Info.default() returns a frozen object; copy it before overriding
  // so Immer's frozen-object invariant is never violated.
  info.name = config.name || modelId;
  info.limit = {
    context: config.limit.context,
    output: config.limit.output,
  };
  info.capabilities = {
    tools: config.tool_call,
    input: config.modalities.input,
    output: config.modalities.output,
  };

  const tierCosts = config.cost?.tiers ?? [];
  const costs: Array<Record<string, unknown>> = [
    {
      input: config.cost?.input ?? 0,
      output: config.cost?.output ?? 0,
      cache: {
        read: config.cost?.cache_read ?? 0,
        write: config.cost?.cache_write ?? 0,
      },
    },
  ];
  for (const tier of tierCosts) {
    costs.push({
      tier: { type: "context", size: tier.tier.size },
      input: tier.input,
      output: tier.output,
      cache: {
        read: tier.cache.read,
        write: tier.cache.write,
      },
    });
  }
  info.cost = costs;

  const variants = Object.entries(config.variants ?? {}).map(([id, variant]) => ({
    id,
    settings: { reasoningEffort: (variant as { reasoningEffort: string }).reasoningEffort },
  }));
  info.variants = variants;

  return info as unknown as ModelSchema.Info;
}

export interface CommandDefinition {
  name: string;
  description: string;
  template: string;
}

export function buildCommandDefinitions(existing?: Array<{ name: string }>): CommandDefinition[] {
  const defined = new Set(existing?.map((c) => c.name) ?? []);
  const all: CommandDefinition[] = [
    {
      name: "actsis-litellm-status",
      description: "Show LiteLLM gateway status and model cache state.",
      template: "Use the actsis_litellm_status tool, then summarize its result for the user.",
    },
    {
      name: "actsis-litellm-models",
      description: "Force-sync the LiteLLM model catalog and show changes.",
      template: "Use the actsis_litellm_models tool, then summarize its result for the user.",
    },
    {
      name: "actsis-litellm-budget",
      description: "Force a budget refresh and report the exact outcome.",
      template: "Use the actsis_litellm_budget tool, then summarize its result for the user.",
    },
    {
      name: "actsis-litellm-logout",
      description: "Revoke LiteLLM credentials and clear local state.",
      template: "Use the actsis_litellm_logout tool, then summarize its result for the user.",
    },
  ];
  return all.filter((command) => !defined.has(command.name));
}

/**
 * Normalize v1-style `thinking` option values into v2 provider options:
 * string values and unknown object types are mapped onto the canonical
 * `{ type: "disabled" | "adaptive" }` shape.
 */
export function normalizeThinkingOption(options: Record<string, unknown>): void {
  const thinking = options.thinking;
  if (typeof thinking === "string") {
    const lower = thinking.toLowerCase();
    options.thinking = lower === "off" || lower === "disabled"
      ? { type: "disabled" }
      : { type: "adaptive" };
    return;
  }
  if (typeof thinking === "object" && thinking !== null) {
    const type = (thinking as { type?: unknown }).type;
    if (type !== "disabled" && type !== "adaptive") {
      options.thinking = { type: "adaptive" };
    }
  }
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
      // Non-classified responses are returned unchanged.
      return response;
    }

    return response;
  };
}

function gatewayUrlField(): Form.Fields[number] {
  return {
    type: "string",
    key: "gatewayUrl",
    title: "Gateway base URL",
    description: "ACTSIS LiteLLM gateway base URL (https://...). Press Enter to use the configured one.",
    placeholder: "https://your-gateway.example.com",
    required: true,
    format: "uri",
  };
}

async function resolveGatewayUrlForAuth(
  answer: Record<string, unknown> | undefined,
  closure: PluginClosure,
): Promise<string> {
  const fromAnswer = typeof answer?.gatewayUrl === "string" ? answer.gatewayUrl.trim() : "";
  if (fromAnswer) {
    return normalizeBaseUrl(fromAnswer);
  }
  if (closure.baseUrl) {
    return closure.baseUrl;
  }
  throw new ConfigError(
    "Gateway URL not configured. Provide it during login or set ACTSIS_LITELLM_URL / plugin options.",
  );
}

/**
 * Register the two auth methods for the integration: OAuth SSO (browser)
 * and the native API key flow. In v2, OpenCode manages credential storage;
 * we only supply discovery, login flow, and token refresh.
 */
export function buildApiKeyMethodRegistration(closure: PluginClosure) {
  return {
    integrationID: closure.providerId,
    method: {
      type: "key" as const,
      label: "Use an API key",
      form: [gatewayUrlField()],
    },
  };
}

export function buildOAuthMethodRegistration(closure: PluginClosure) {
  return buildAuthMethodRegistrations(closure).oauth;
}

/**
 * Register the two auth methods for the integration: OAuth SSO (browser)
 * and the native API key flow. In v2, OpenCode manages credential storage;
 * we only supply discovery, login flow, and token refresh.
 */
const OAUTH_METHOD_ID = "sso-browser";
const OAUTH_METHOD_BRANDED_ID = OAUTH_METHOD_ID as IntegrationSchema.MethodID;

export function buildAuthMethodRegistrations(closure: PluginClosure) {
  const oauth: {
    integrationID: string;
    method: {
      id: string;
      type: "oauth";
      label: string;
      form: Form.Fields;
    };
    authorize: (answer: Form.Answer) => Promise<{
      url: string;
      instructions: string;
      mode: "auto";
      callback: Promise<Credential.OAuth>;
    }>;
    refresh: (credential: Credential.OAuth) => Promise<Credential.OAuth>;
    label?: (credential: Credential.OAuth) => string | undefined;
  } = {
    integrationID: closure.providerId,
    method: {
      id: OAUTH_METHOD_ID,
      type: "oauth",
      label: "Sign in with SSO (browser)",
      form: [gatewayUrlField()],
    },
    async authorize(answer) {
      const baseUrl = await resolveGatewayUrlForAuth(
        answer as Record<string, unknown> | undefined,
        closure,
      );

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

      const authorization = {
        url: flow.url,
        instructions: flow.instructions,
        mode: "auto" as const,
        callback: (async (): Promise<Credential.OAuth> => {
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
              schemeUpgraded,
            },
            closure.stateDir,
          );
          return {
            type: "oauth" as const,
            methodID: OAUTH_METHOD_BRANDED_ID,
            refresh: result.refresh,
            access: result.access,
            expires: result.expires,
            metadata: {
              userId: result.userId,
              teamId: result.teamId,
            },
          };
        })(),
      };

      return authorization;
    },
    async refresh(credential) {
      const next = await ensureFreshToken(
        { access: credential.access, refresh: credential.refresh, expires: credential.expires },
        {
          state: await readPluginState(closure.stateDir),
          timeoutMs: closure.requestTimeoutMs,
        },
      );
      // ensureFreshToken refreshes near expiry and otherwise returns the same
      // access token; OpenCode persists whatever full credential we return.
      return {
        type: "oauth" as const,
        methodID: credential.methodID,
        refresh: credential.refresh,
        access: next,
        expires: credential.expires,
        metadata: credential.metadata,
      };
    },
    label(credential) {
      if (credential.metadata && typeof credential.metadata === "object") {
        const userId = (credential.metadata as Record<string, unknown>).userId;
        if (typeof userId === "string" && userId) return userId;
      }
      return undefined;
    },
  };

  const apiKey = buildApiKeyMethodRegistration(closure);

  return { oauth, apiKey };
}

/**
 * Force-refresh the stored budget snapshot. Shared by the session.idle event
 * subscription and the budget tool; failures are silent — the tools force a
 * fresh fetch and report the reason themselves.
 */
export async function runBudgetRefresh(closure: PluginClosure): Promise<void> {
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
}

/**
 * Build the initial v2 Model.Info list: fetch the catalog when credentials
 * are available, and fall back to the on-disk cache otherwise.
 */
export async function buildInitialModels(
  closure: PluginClosure,
): Promise<Record<string, ModelSchema.Info>> {
  const entry = await readAuthEntry(closure.authPath, closure.providerId);
  const token = entry?.type === "oauth" ? entry.access : entry?.type === "api" ? entry.key : undefined;

  const state = await readPluginState(closure.stateDir);
  const baseUrl = closure.baseUrl ??
    (state?.gatewayUrl ? normalizeBaseUrl(state.gatewayUrl) : null);

  const toRecord = (models: Record<string, OpencodeModelConfig>) => {
    const record: Record<string, ModelSchema.Info> = {};
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
          requestTimeoutMs: closure.requestTimeoutMs,
        },
        token,
      );
      const record: Record<string, OpencodeModelConfig> = { ...cachedRecord };
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

/**
 * The v2 setup context type, structural so tests can exercise setup with
 * minimal fakes without importing OpenCode runtime internals.
 */
export interface SetupContext {
  readonly options: Record<string, unknown>;
  readonly provider: {
    readonly transform: (callback: (editor: {
      add: (input: { info: unknown; models: unknown[] }) => void;
    }) => void) => Promise<{ dispose: () => Promise<void> }>;
  };
  readonly tool: {
    readonly transform: (callback: (editor: {
      add: (tool: unknown) => void;
    }) => void) => Promise<{ dispose: () => Promise<void> }>;
  };
  readonly command: {
    readonly transform: (callback: (editor: {
      add: (definition: { name: string; description?: string; execute: (input: { sessionID: string; delivery?: unknown }) => Promise<void> }) => void;
    }) => void) => Promise<{ dispose: () => Promise<void> }>;
  };
  readonly integration: {
    readonly transform: (callback: (editor: {
      method: {
        update: (input: unknown) => void;
      };
    }) => void) => Promise<{ dispose: () => Promise<void> }>;
  };
  readonly event: {
    readonly subscribe: (options?: { signal?: AbortSignal }) => AsyncIterable<{
      readonly type: string;
      readonly data?: Record<string, unknown>;
    }>;
  };
  readonly session: {
    readonly prompt: (input: { sessionID: string; text: string; delivery?: unknown }) => Promise<unknown>;
    readonly hook: (name: string, callback: (input: Record<string, unknown>) => unknown, options?: { providerID?: string }) => unknown;
  };
}

/**
 * Server plugin (v2): registers the ACTSIS LiteLLM gateway provider, its
 * dynamic model catalog, the OAuth + API-key auth methods on the linked
 * integration, the four slash commands, the four tools, the session hooks
 * (headers / thinking normalization / informational error classification),
 * and the session.idle budget refresh loop.
 */
export default Plugin.define({
  id: DEFAULT_PROVIDER_ID,
  async setup(ctx: unknown) {
    const context = ctx as SetupContext;
    const closure = await resolveClosure(
      context.options as Record<string, unknown> | undefined,
      defaultAuthPath(),
      resolveStateDir(),
    );

    // --- Integration auth methods (must exist before the provider binds) ---
    await context.integration.transform((editor) => {
      const { oauth, apiKey } = buildAuthMethodRegistrations(closure);
      editor.method.update(oauth);
      editor.method.update(apiKey);
    });

    // --- Provider with its dynamic model catalog ---
    // Transform callbacks must stay synchronous (Immer registry contract):
    // load the catalog before registration and capture it in the closure.
    const providerInfo = buildProviderInfo(closure);
    const initialModels = await buildInitialModels(closure);
    await context.provider.transform((editor) => {
      editor.add({
        info: providerInfo,
        models: Object.values(initialModels),
      });
    });

    // --- Tools ---
    await context.tool.transform((editor) => {
      const toolDeps: ToolDeps = {
        providerId: closure.providerId,
        stateDir: closure.stateDir,
        authPath: closure.authPath,
      };
      for (const info of buildLitellmToolInfos(toolDeps)) {
        editor.add(info as unknown);
      }
    });

    // --- Slash commands (submit a prompt mentioning the matching tool) ---
    await context.command.transform((editor) => {
      for (const command of buildCommandDefinitions()) {
        editor.add({
          name: command.name,
          description: command.description,
          execute: async ({ sessionID, delivery }: { sessionID: string; delivery?: unknown }) => {
            await context.session.prompt({
              sessionID,
              text: command.template,
              ...(delivery !== undefined ? { delivery } : {}),
            });
          },
        });
      }
    });

    // --- Session hooks, scoped to this provider ---
    await context.session.hook(
      "model.request",
      (event) => {
        const ev = event as { sessionID?: string; headers?: Record<string, string> };
        const headers = ev.headers;
        if (headers && ev.sessionID) {
          headers["X-Litellm-Session-ID"] = ev.sessionID;
        }
      },
      { providerID: closure.providerId },
    );

    await context.session.hook(
      "context",
      (event) => {
        const ev = event as { options?: Record<string, unknown> };
        if (ev.options) {
          normalizeThinkingOption(ev.options);
        }
      },
      { providerID: closure.providerId },
    );

    // Read-only informational classification of gateway limit errors on
    // non-ok responses. Never rewrites the response; best effort only.
    await context.session.hook(
      "http.response",
      (event) => {
        const ev = event as { response?: Response; model?: { modelID?: string } };
        const response = ev.response;
        if (!response) return;
        void Promise.resolve(response.clone().text().catch(() => ""))
          .then((text) => {
            if (!text) return;
            if (isOverflowErrorMessage(text)) {
              console.warn(
                `[actsis-litellm] context overflow on model ${ev.model?.modelID ?? "unknown"}: ${text.slice(0, 300)}`,
              );
              return;
            }
            const info = parseLimitError(text);
            if (info?.kind === "budget_exceeded") {
              console.warn(`[actsis-litellm] budget warning: ${formatBudgetWarning(info)}`);
            } else if (info?.kind === "throttling_error") {
              console.warn(`[actsis-litellm] throttle warning: ${formatThrottleWarning(info)}`);
            }
          })
          .catch(() => {
            // Informational only.
          });
      },
      { providerID: closure.providerId },
    );

    // --- session.idle budget refresh loop ---
    const controller = new AbortController();
    const eventLoop = (async () => {
      try {
        for await (const event of context.event.subscribe({ signal: controller.signal })) {
          if (event.type !== "session.idle") continue;
          try {
            await runBudgetRefresh(closure);
          } catch {
            // Background refresh: failures are silent.
          }
        }
      } catch {
        // Subscribe/stream failures abort the loop silently.
      }
    })();
    void eventLoop;

    return async () => {
      controller.abort();
    };
  },
});
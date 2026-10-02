import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import serverPlugin, {
  resolveClosure,
  buildProviderInfo,
  mapModelConfigToInfo,
  buildCommandDefinitions,
  buildInitialModels,
  buildApiKeyMethodRegistration,
  buildOAuthMethodRegistration,
  normalizeThinkingOption,
  runBudgetRefresh,
  makeAuthFetch,
  type PluginClosure,
  type SetupContext,
} from "../src/plugin.ts";
import { writePluginState, readPluginState } from "../src/state.ts";
import { defaultAuthPath } from "../src/auth-store.ts";
import type { OpencodeModelConfig } from "../src/catalog-cache.ts";

function makeModelConfig(
  overrides: Partial<OpencodeModelConfig> = {},
): OpencodeModelConfig {
  return {
    name: "gpt-4",
    tool_call: true,
    reasoning: true,
    limit: { context: 128_000, output: 16_384 },
    modalities: { input: ["text"], output: ["text"] },
    ...overrides,
  };
}

interface RegisteredRecord {
  info: Record<string, unknown>;
  models: Array<Record<string, unknown>>;
}

function makeFakeContext(options: Record<string, unknown> = {}) {
  const providers: RegisteredRecord[] = [];
  const tools: Array<Record<string, unknown>> = [];
  const commands: Array<{
    name: string;
    description?: string;
    execute: (input: { sessionID: string; prompt?: unknown; delivery?: unknown }) => Promise<void>;
  }> = [];
  const methods: Array<Record<string, unknown>> = [];
  const hooks: Record<
    string,
    {
      callback: (input: Record<string, unknown>) => unknown;
      options?: { providerID?: string };
    }
  > = {};
  const sessionPrompt = vi.fn(async () => ({}) as unknown);
  const registrations: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];

  const register = () => {
    const dispose = vi.fn(async () => {});
    registrations.push({ dispose });
    return dispose;
  };

  const fake = {
    options,
    provider: {
      transform: async (cb: (e: any) => Promise<void> | void) => {
        await cb({
          list: () => [],
          get: () => undefined,
          add: (input: RegisteredRecord) => providers.push(input),
          update: () => {},
          remove: () => {},
          models: { set: () => {}, update: () => {}, remove: () => {} },
        });
        return { dispose: register() };
      },
    },
    tool: {
      transform: async (cb: (e: any) => void) => {
        cb({
          list: () => [],
          get: () => undefined,
          add: (tool: Record<string, unknown>) => tools.push(tool),
          update: () => {},
          remove: () => {},
          namespace: () => {},
        });
        return { dispose: register() };
      },
    },
    command: {
      transform: async (cb: (e: any) => void) => {
        cb({ add: (command: (typeof commands)[number]) => commands.push(command) });
        return { dispose: register() };
      },
    },
    integration: {
      connection: {
        active: async () => undefined,
        resolve: async () => undefined,
      },
      transform: async (cb: (e: any) => void) => {
        cb({
          list: () => [],
          get: () => undefined,
          update: () => {},
          remove: () => {},
          method: {
            list: () => [],
            update: (input: Record<string, unknown>) => methods.push(input),
            remove: () => {},
          },
        });
        return { dispose: register() };
      },
    },
    session: {
      prompt: sessionPrompt,
      hook: (
        name: string,
        callback: (input: Record<string, unknown>) => unknown,
        hookOptions?: { providerID?: string },
      ) => {
        hooks[name] = { callback, options: hookOptions };
        return { dispose: register() };
      },
    },
    event: {
      subscribe: () => (async function* () {})(),
    },
  };

  return {
    ctx: fake as unknown as SetupContext,
    providers,
    tools,
    commands,
    methods,
    hooks,
    sessionPrompt,
    registrations,
  };
}

function makeClosure(overrides: Partial<PluginClosure> = {}): PluginClosure {
  return {
    baseUrl: "https://gw.example.com",
    providerId: "actsis-litellm",
    catalogTtlMs: 15 * 60 * 1000,
    requestTimeoutMs: 30_000,
    authPath: defaultAuthPath(),
    stateDir: undefined,
    ...overrides,
  };
}

describe("resolveClosure", () => {
  it("reads env URL over options and stored URL", async () => {
    const original = process.env.ACTSIS_LITELLM_URL;
    process.env.ACTSIS_LITELLM_URL = "https://env.example.com";
    try {
      const closure = await resolveClosure({ url: "https://opt.example.com" });
      expect(closure.baseUrl).toBe("https://env.example.com");
    } finally {
      if (original !== undefined) process.env.ACTSIS_LITELLM_URL = original;
      else delete process.env.ACTSIS_LITELLM_URL;
    }
  });

  it("falls back to options URL when env is absent", async () => {
    const original = process.env.ACTSIS_LITELLM_URL;
    delete process.env.ACTSIS_LITELLM_URL;
    try {
      const closure = await resolveClosure({ url: "https://opt.example.com" });
      expect(closure.baseUrl).toBe("https://opt.example.com");
    } finally {
      if (original !== undefined) process.env.ACTSIS_LITELLM_URL = original;
    }
  });

  it("falls back to the stored state gatewayUrl when env and options are absent", async () => {
    const original = process.env.ACTSIS_LITELLM_URL;
    const originalStateDir = process.env.ACTSIS_LITELLM_STATE_DIR;
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "actsis-litellm-resolve-"));
    delete process.env.ACTSIS_LITELLM_URL;
    process.env.ACTSIS_LITELLM_STATE_DIR = tmpDir;
    try {
      await writePluginState(
        { version: 1, gatewayUrl: "https://statefile.example.com", providerId: "actsis-litellm" },
        tmpDir,
      );
      const closure = await resolveClosure();
      expect(closure.baseUrl).toBe("https://statefile.example.com");
    } finally {
      if (original !== undefined) process.env.ACTSIS_LITELLM_URL = original;
      else delete process.env.ACTSIS_LITELLM_URL;
      if (originalStateDir !== undefined) process.env.ACTSIS_LITELLM_STATE_DIR = originalStateDir;
      else delete process.env.ACTSIS_LITELLM_STATE_DIR;
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("makeAuthFetch", () => {
  it("passes through successful responses with Authorization header", async () => {
    const captured: { url: string; headers: Headers }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      captured.push({ url: request.url, headers: new Headers(request.headers) });
      return new Response("ok", { status: 200 });
    });

    const fetch = makeAuthFetch(() => Promise.resolve("token-1"), fetchImpl);
    const response = await fetch("https://gw.example.com/v1/chat/completions", { headers: { "X-Api-Key": "old" } });

    expect(response.status).toBe(200);
    expect(captured[0].headers.get("Authorization")).toBe("Bearer token-1");
    expect(captured[0].headers.get("X-Api-Key")).toBeNull();
  });

  it("throws budget exceeded for budget error body", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ type: "budget_exceeded", message: "Current cost: 12.34, Max budget: 10" }),
        { status: 400 },
      ),
    );
    const fetch = makeAuthFetch(() => Promise.resolve("token-1"), fetchImpl);
    await expect(fetch("https://gw.example.com/v1/chat/completions")).rejects.toThrow(/Budget exceeded/);
  });

  it("throws context_length_exceeded for overflow body", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: { message: "maximum context length exceeded" } }),
        { status: 400 },
      ),
    );
    const fetch = makeAuthFetch(() => Promise.resolve("token-1"), fetchImpl);
    await expect(fetch("https://gw.example.com/v1/chat/completions")).rejects.toThrow(/context_length_exceeded/);
  });
});

describe("buildProviderInfo", () => {
  it("builds a v2 Provider.Info bound to the integration", () => {
    const info = buildProviderInfo(makeClosure()) as unknown as Record<string, unknown>;

    expect(info.id).toBe("actsis-litellm");
    expect(info.name).toBe("Actsis LiteLLM");
    expect(info.activation).toBe("enabled");
    expect(info.package).toBe("@opencode/ai/providers/openai-compatible");
    expect(info.integrationID).toBe("actsis-litellm");
    expect(info.settings).toEqual({ baseURL: "https://gw.example.com/v1" });
  });

  it("uses an empty baseURL when no gateway URL is resolved", () => {
    const info = buildProviderInfo(makeClosure({ baseUrl: null })) as unknown as Record<string, unknown>;
    expect(info.settings).toEqual({ baseURL: "" });
  });
});

describe("mapModelConfigToInfo", () => {
  it("maps a catalog config onto Model.Info.default with overrides", () => {
    const config = makeModelConfig({
      name: "gpt-4",
      modalities: { input: ["text", "image"], output: ["text"] },
      cost: {
        input: 2.5,
        output: 10,
        cache_read: 1.25,
        cache_write: 5,
        tiers: [
          { input: 5, output: 20, cache: { read: 2, write: 10 }, tier: { type: "context", size: 128_000 } },
        ],
      },
      variants: { high: { reasoningEffort: "high" } },
    });

    const info = mapModelConfigToInfo("actsis-litellm", "gpt-4", config) as unknown as Record<string, unknown>;

    expect(info.id).toBe("gpt-4");
    expect(info.modelID).toBe("gpt-4");
    expect(info.providerID).toBe("actsis-litellm");
    expect(info.name).toBe("gpt-4");
    expect(info.status).toBe("active");
    expect(info.enabled).toBe(true);
    expect(info.limit).toEqual({ context: 128_000, output: 16_384 });
    expect(info.capabilities).toEqual({ tools: true, input: ["text", "image"], output: ["text"] });
    expect(info.cost).toEqual([
      { input: 2.5, output: 10, cache: { read: 1.25, write: 5 } },
      {
        tier: { type: "context", size: 128_000 },
        input: 5,
        output: 20,
        cache: { read: 2, write: 10 },
      },
    ]);
    expect(info.variants).toEqual([
      { id: "high", settings: { reasoningEffort: "high" } },
    ]);
  });

  it("falls back to Model.Info defaults for missing cost, modalities, and limits", () => {
    const config = makeModelConfig({
      name: "small",
      tool_call: false,
      limit: { context: 200_000, output: 32_000 },
    });
    const info = mapModelConfigToInfo("actsis-litellm", "small", config) as unknown as Record<string, unknown>;

    expect(info.name).toBe("small");
    expect(info.capabilities).toEqual({ tools: false, input: ["text"], output: ["text"] });
    expect(info.cost).toEqual([
      { input: 0, output: 0, cache: { read: 0, write: 0 } },
    ]);
    expect(info.variants).toEqual([]);
    expect(info.limit).toEqual({ context: 200_000, output: 32_000 });
  });
});

describe("buildCommandDefinitions", () => {
  it("exposes all four commands in v2 shape (name/description/template)", () => {
    const commands = buildCommandDefinitions();
    expect(commands.map((c) => c.name)).toEqual([
      "actsis-litellm-status",
      "actsis-litellm-models",
      "actsis-litellm-budget",
      "actsis-litellm-logout",
    ]);
    expect(commands[0].template).toContain("actsis_litellm_status tool");
    expect(commands[1].description).toContain("Force-sync");
    expect(commands[2].template).toContain("actsis_litellm_budget tool");
    expect(commands[3].description).toContain("Revoke");
  });
});

describe("normalizeThinkingOption", () => {
  it("maps string values", () => {
    const off: Record<string, unknown> = { thinking: "off" };
    normalizeThinkingOption(off);
    expect(off.thinking).toEqual({ type: "disabled" });

    const disabled: Record<string, unknown> = { thinking: "DISABLED" };
    normalizeThinkingOption(disabled);
    expect(disabled.thinking).toEqual({ type: "disabled" });

    const adaptive: Record<string, unknown> = { thinking: "on" };
    normalizeThinkingOption(adaptive);
    expect(adaptive.thinking).toEqual({ type: "adaptive" });
  });

  it("repairs invalid object types and preserves known ones", () => {
    const invalid: Record<string, unknown> = { thinking: { type: "bogus" } };
    normalizeThinkingOption(invalid);
    expect(invalid.thinking).toEqual({ type: "adaptive" });

    const disabled: Record<string, unknown> = { thinking: { type: "disabled" } };
    normalizeThinkingOption(disabled);
    expect(disabled.thinking).toEqual({ type: "disabled" });

    const adaptive: Record<string, unknown> = { thinking: { type: "adaptive" } };
    normalizeThinkingOption(adaptive);
    expect(adaptive.thinking).toEqual({ type: "adaptive" });
  });

  it("leaves other shapes untouched", () => {
    const untouched: Record<string, unknown> = {};
    normalizeThinkingOption(untouched);
    expect(untouched.thinking).toBeUndefined();
  });
});

describe("buildApiKeyMethodRegistration", () => {
  it("registers a native key method with a gateway URL form field", () => {
    const registration = buildApiKeyMethodRegistration(makeClosure()) as unknown as Record<string, unknown>;
    expect(registration.integrationID).toBe("actsis-litellm");

    const method = registration.method as Record<string, unknown>;
    expect(method.type).toBe("key");
    expect(method.label).toBe("Use an API key");

    const form = method.form as Array<Record<string, unknown>>;
    expect(form).toHaveLength(1);
    expect(form[0].type).toBe("string");
    expect(form[0].key).toBe("gatewayUrl");
    expect(form[0].format).toBe("uri");
  });
});

describe("OAuth method registration", () => {
  let tmpDir: string;
  const savedEnv: { url?: string; stateDir?: string; dataHome?: string } = {};

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "actsis-litellm-oauth-test-"));
    savedEnv.url = process.env.ACTSIS_LITELLM_URL;
    savedEnv.stateDir = process.env.ACTSIS_LITELLM_STATE_DIR;
    savedEnv.dataHome = process.env.XDG_DATA_HOME;
    delete process.env.ACTSIS_LITELLM_URL;
    process.env.ACTSIS_LITELLM_STATE_DIR = tmpDir;
    // Isolation: any state write that escapes the explicit dir must land in
    // tmpDir, never in the real default state directory.
    process.env.XDG_DATA_HOME = tmpDir;
  });

  afterEach(async () => {
    if (savedEnv.url !== undefined) process.env.ACTSIS_LITELLM_URL = savedEnv.url;
    else delete process.env.ACTSIS_LITELLM_URL;
    if (savedEnv.stateDir !== undefined) process.env.ACTSIS_LITELLM_STATE_DIR = savedEnv.stateDir;
    else delete process.env.ACTSIS_LITELLM_STATE_DIR;
    if (savedEnv.dataHome !== undefined) process.env.XDG_DATA_HOME = savedEnv.dataHome;
    else delete process.env.XDG_DATA_HOME;
    vi.unstubAllGlobals();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function stubGatewayFetch() {
    const realFetch = globalThis.fetch;
    return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      // The loopback callback server is real; let browser redirects through.
      if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
        return realFetch(input, init);
      }
      if (url.pathname === "/.well-known/litellm-cli-auth") {
        return new Response(
          JSON.stringify({
            contract_version: 1,
            issuer: "https://gw.example.com",
            authorization_endpoint: "https://gw.example.com/authorize",
            token_endpoint: "https://gw.example.com/token",
            registration_endpoint: "https://gw.example.com/register",
            revocation_endpoint: "https://gw.example.com/revoke",
            resource: "https://gw.example.com",
            code_challenge_methods_supported: ["S256"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            token_endpoint_auth_methods_supported: ["none"],
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.pathname === "/register") {
        return new Response(JSON.stringify({ client_id: "client-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/token") {
        return new Response(
          JSON.stringify({
            access_token: "access-1",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "refresh-1",
            user_id: "user-1",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
  }

  it("exposes an oauth method with a gateway URL form field", () => {
    const registration = buildOAuthMethodRegistration(makeClosure()) as unknown as Record<string, unknown>;
    expect(registration.integrationID).toBe("actsis-litellm");

    const method = registration.method as Record<string, unknown>;
    expect(method.type).toBe("oauth");
    expect(method.label).toBe("Sign in with SSO (browser)");
    const form = method.form as Array<Record<string, unknown>>;
    expect(form[0].key).toBe("gatewayUrl");
  });

  it("authorize returns an auto mode authorization completing as a v2 OAuth credential", async () => {
    vi.stubGlobal("fetch", stubGatewayFetch());
    const registration = buildOAuthMethodRegistration(
      makeClosure({ stateDir: tmpDir }),
    ) as unknown as {
      authorize: (answer: Record<string, unknown>) => Promise<{
        url: string;
        instructions: string;
        mode: "auto";
        callback: Promise<Record<string, unknown>>;
      }>;
    };

    const authorization = await registration.authorize({ gatewayUrl: "https://gw.example.com" });

    expect(authorization.mode).toBe("auto");
    expect(authorization.url).toContain("https://gw.example.com/authorize");
    expect(authorization.instructions).toContain("browser");

    const authorizeUrl = new URL(authorization.url);
    const redirectUri = authorizeUrl.searchParams.get("redirect_uri")!;
    const state = authorizeUrl.searchParams.get("state")!;
    await fetch(`${redirectUri}?code=AUTHCODE&state=${state}`, { method: "POST" });

    const credential = await authorization.callback;
    expect(credential).toMatchObject({
      type: "oauth",
      methodID: "sso-browser",
      access: "access-1",
      refresh: "refresh-1",
    });
    expect((credential.expires as number)).toBeGreaterThan(Date.now());

    const state_ = await readPluginState(tmpDir);
    expect(state_?.authMode).toBe("oauth");
    expect(state_?.providerId).toBe("actsis-litellm");
    expect(state_?.gatewayUrl).toBe("https://gw.example.com");
  });

  it("runLoginFlow state write never touches the default state directory", async () => {
    // Regression: an aborted/login-callback state write routed through an
    // undefined dir used to land in the real ~/.local/share state.json.
    // With XDG_DATA_HOME pointed at tmpDir, the "default" dir is inside tmpDir,
    // so a write escaping the closure's stateDir would create that file.
    const defaultStateFile = path.join(
      tmpDir,
      "opencode",
      "actsis-litellm",
      "state.json",
    );

    vi.stubGlobal("fetch", stubGatewayFetch());
    const registration = buildOAuthMethodRegistration(
      makeClosure({ stateDir: tmpDir }),
    ) as unknown as {
      authorize: (answer: Record<string, unknown>) => Promise<{
        url: string;
        mode: "auto";
        callback: Promise<Record<string, unknown>>;
      }>;
    };

    const authorization = await registration.authorize({ gatewayUrl: "https://gw.example.com" });
    const authorizeUrl = new URL(authorization.url);
    const redirectUri = authorizeUrl.searchParams.get("redirect_uri")!;
    const state = authorizeUrl.searchParams.get("state")!;
    await fetch(`${redirectUri}?code=AUTHCODE&state=${state}`, { method: "POST" });
    await authorization.callback;

    // Only the tmpDir state file exists; the default-path file must not.
    expect(await stat(defaultStateFile).then(
      () => true,
      () => false,
    )).toBe(false);
    expect((await readPluginState(tmpDir))?.providerId).toBe("actsis-litellm");
  });

  it("authorize rejects when no gateway URL is resolvable", async () => {
    const registration = buildOAuthMethodRegistration(
      makeClosure({ baseUrl: null, stateDir: tmpDir }),
    ) as unknown as {
      authorize: (answer: Record<string, unknown>) => Promise<unknown>;
    };
    await expect(registration.authorize({})).rejects.toThrow(/Gateway URL not configured/);
  });
});

describe("runBudgetRefresh", () => {
  let tmpDir: string;
  const savedEnv: { stateDir?: string; dataHome?: string } = {};

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "actsis-litellm-event-test-"));
    savedEnv.stateDir = process.env.ACTSIS_LITELLM_STATE_DIR;
    savedEnv.dataHome = process.env.XDG_DATA_HOME;
    process.env.ACTSIS_LITELLM_STATE_DIR = tmpDir;
    // Point defaultAuthPath() inside the tmp dir.
    process.env.XDG_DATA_HOME = tmpDir;
    await writePluginState(
      { version: 1, gatewayUrl: "https://gw.example.com", providerId: "actsis-litellm" },
      tmpDir,
    );
    await mkdir(path.dirname(defaultAuthPath()), { recursive: true });
    await writeFile(
      defaultAuthPath(),
      JSON.stringify({ "actsis-litellm": { type: "api", key: "sk-test" } }),
    );
  });

  afterEach(async () => {
    if (savedEnv.stateDir !== undefined) process.env.ACTSIS_LITELLM_STATE_DIR = savedEnv.stateDir;
    else delete process.env.ACTSIS_LITELLM_STATE_DIR;
    if (savedEnv.dataHome !== undefined) process.env.XDG_DATA_HOME = savedEnv.dataHome;
    else delete process.env.XDG_DATA_HOME;
    await rm(tmpDir, { recursive: true, force: true });
  });

  function stubBudgetFetch(spend: number) {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/key/info") {
        return new Response(JSON.stringify({ spend, max_budget: 100 }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }));
  }

  it("persists a budget snapshot (session.idle refresh)", async () => {
    stubBudgetFetch(7.89);
    const closure = await resolveClosure();

    await expect(runBudgetRefresh(closure)).resolves.toBeUndefined();

    const state = await readPluginState(tmpDir);
    expect(state?.lastBudgetSnapshot?.primary.spend).toBe(7.89);
    expect(state?.budgetRefreshedAt).toEqual(expect.any(Number));
    expect(Number.isFinite(state!.budgetRefreshedAt!)).toBe(true);
    vi.unstubAllGlobals();
  });

  it("does nothing without a gateway URL or credential", async () => {
    stubBudgetFetch(7.89);
    await writePluginState({ version: 1 }, tmpDir);
    const closure = await resolveClosure();

    await runBudgetRefresh(closure);

    const state = await readPluginState(tmpDir);
    expect(state?.lastBudgetSnapshot).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("does not throw when the budget fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    const closure = await resolveClosure();

    await expect(runBudgetRefresh(closure)).resolves.toBeUndefined();

    const state = await readPluginState(tmpDir);
    expect(state?.lastBudgetSnapshot).toBeUndefined();
    vi.unstubAllGlobals();
  });
});

describe("buildInitialModels", () => {
  let tmpDir: string;
  const savedEnv: { url?: string; stateDir?: string; dataHome?: string } = {};

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "actsis-litellm-models-test-"));
    savedEnv.url = process.env.ACTSIS_LITELLM_URL;
    savedEnv.stateDir = process.env.ACTSIS_LITELLM_STATE_DIR;
    savedEnv.dataHome = process.env.XDG_DATA_HOME;
    delete process.env.ACTSIS_LITELLM_URL;
    process.env.ACTSIS_LITELLM_STATE_DIR = tmpDir;
    process.env.XDG_DATA_HOME = tmpDir;
    await mkdir(path.dirname(defaultAuthPath()), { recursive: true });
  });

  afterEach(async () => {
    if (savedEnv.url !== undefined) process.env.ACTSIS_LITELLM_URL = savedEnv.url;
    else delete process.env.ACTSIS_LITELLM_URL;
    if (savedEnv.stateDir !== undefined) process.env.ACTSIS_LITELLM_STATE_DIR = savedEnv.stateDir;
    else delete process.env.ACTSIS_LITELLM_STATE_DIR;
    if (savedEnv.dataHome !== undefined) process.env.XDG_DATA_HOME = savedEnv.dataHome;
    else delete process.env.XDG_DATA_HOME;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("fetches the catalog when a credential exists and saves the cache", async () => {
    await writeFile(
      defaultAuthPath(),
      JSON.stringify({ "actsis-litellm": { type: "api", key: "sk-test" } }),
    );
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/models") {
        return new Response(
          JSON.stringify({ data: [{ id: "gpt-4", mode: "chat" }] }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.pathname === "/v1/model/info") {
        return new Response(JSON.stringify([]), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }));

    const closure = makeClosure({ stateDir: tmpDir, authPath: defaultAuthPath() });
    const models = await buildInitialModels(closure);

    expect(Object.keys(models)).toEqual(["gpt-4"]);
    expect(models["gpt-4"].name).toBe("gpt-4");
    vi.unstubAllGlobals();
  });

  it("falls back to the cached catalog when no credential is available", async () => {
    await writeFile(
      path.join(tmpDir, "models-cache.json"),
      JSON.stringify({
        version: 2,
        fetchedAt: Date.now(),
        models: { cached: makeModelConfig({ name: "cached" }) },
      }),
    );

    const closure = makeClosure({ stateDir: tmpDir, authPath: defaultAuthPath() });
    const models = await buildInitialModels(closure);

    expect(Object.keys(models)).toEqual(["cached"]);
  });

  it("falls back to the cache when the fresh fetch fails", async () => {
    await writeFile(
      defaultAuthPath(),
      JSON.stringify({ "actsis-litellm": { type: "api", key: "sk-test" } }),
    );
    await writeFile(
      path.join(tmpDir, "models-cache.json"),
      JSON.stringify({
        version: 2,
        fetchedAt: Date.now(),
        models: { cached: makeModelConfig({ name: "cached" }) },
      }),
    );
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));

    const closure = makeClosure({ stateDir: tmpDir, authPath: defaultAuthPath() });
    const models = await buildInitialModels(closure);

    expect(Object.keys(models)).toEqual(["cached"]);
    vi.unstubAllGlobals();
  });
});

describe("server plugin (v2 wiring)", () => {
  let tmpDir: string;
  const savedEnv: { url?: string; stateDir?: string; dataHome?: string } = {};

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "actsis-litellm-setup-test-"));
    savedEnv.url = process.env.ACTSIS_LITELLM_URL;
    savedEnv.stateDir = process.env.ACTSIS_LITELLM_STATE_DIR;
    savedEnv.dataHome = process.env.XDG_DATA_HOME;
    delete process.env.ACTSIS_LITELLM_URL;
    process.env.ACTSIS_LITELLM_STATE_DIR = tmpDir;
    process.env.XDG_DATA_HOME = tmpDir;
  });

  afterEach(async () => {
    if (savedEnv.url !== undefined) process.env.ACTSIS_LITELLM_URL = savedEnv.url;
    else delete process.env.ACTSIS_LITELLM_URL;
    if (savedEnv.stateDir !== undefined) process.env.ACTSIS_LITELLM_STATE_DIR = savedEnv.stateDir;
    else delete process.env.ACTSIS_LITELLM_STATE_DIR;
    if (savedEnv.dataHome !== undefined) process.env.XDG_DATA_HOME = savedEnv.dataHome;
    else delete process.env.XDG_DATA_HOME;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("registers provider, tools, commands, integration methods, and session hooks", async () => {
    const { ctx, providers, tools, commands, methods, hooks } = makeFakeContext();
    const cleanup = await serverPlugin.setup(ctx as never);

    expect(serverPlugin.id).toBe("actsis-litellm");
    expect(providers).toHaveLength(1);
    expect(providers[0].info.integrationID).toBe("actsis-litellm");
    expect(providers[0].info.package).toBe("@opencode/ai/providers/openai-compatible");

    const toolNames = tools.map((t) => t.name);
    for (const name of [
      "actsis_litellm_status",
      "actsis_litellm_budget",
      "actsis_litellm_models",
      "actsis_litellm_logout",
    ]) {
      expect(toolNames).toContain(name);
    }

    expect(commands.map((c) => c.name)).toEqual([
      "actsis-litellm-status",
      "actsis-litellm-models",
      "actsis-litellm-budget",
      "actsis-litellm-logout",
    ]);

    expect(methods).toHaveLength(2);

    for (const hookName of ["model.request", "context", "http.response"]) {
      expect(hooks[hookName].options?.providerID).toBe("actsis-litellm");
    }

    await cleanup?.();
  });

  it("tools are registered with JSON Schema input and {content} results", async () => {
    const { ctx, tools } = makeFakeContext();
    await serverPlugin.setup(ctx as never);

    const status = tools.find((t) => t.name === "actsis_litellm_status") as Record<string, unknown>;
    expect(status.description).toContain("gateway status");
    expect((status.input as Record<string, unknown>).type).toBe("object");
    expect(typeof status.execute).toBe("function");

    const result = await (status.execute as (input: unknown, ctx: unknown) => Promise<{ content: string }>)({}, undefined);
    expect(result.content).toContain("Provider: actsis-litellm");
  });

  it("the model.request hook injects the litellm session header", async () => {
    const { ctx, hooks } = makeFakeContext();
    await serverPlugin.setup(ctx as never);

    const headers: Record<string, string> = {};
    await hooks["model.request"].callback({
      sessionID: "s1",
      headers,
      model: { providerID: "actsis-litellm", modelID: "gpt-4" },
    });
    expect(headers["X-Litellm-Session-ID"]).toBe("s1");
  });

  it("commands submit the tool prompt through ctx.session.prompt", async () => {
    const { ctx, commands, sessionPrompt } = makeFakeContext();
    await serverPlugin.setup(ctx as never);

    await commands[0].execute({ sessionID: "s1", delivery: "steer" });
    expect(sessionPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: "s1",
        text: expect.stringContaining("actsis_litellm_status"),
        delivery: "steer",
      }),
    );
  });

  it("the session.idle event loop triggers a budget refresh", async () => {
    await writePluginState(
      { version: 1, gatewayUrl: "https://gw.example.com", providerId: "actsis-litellm" },
      tmpDir,
    );
    await mkdir(path.dirname(defaultAuthPath()), { recursive: true });
    await writeFile(
      defaultAuthPath(),
      JSON.stringify({ "actsis-litellm": { type: "api", key: "sk-test" } }),
    );
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/key/info") {
        return new Response(JSON.stringify({ spend: 3.21, max_budget: 100 }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }));

    // Event stream that emits one session.idle then closes.
    const { ctx } = makeFakeContext();
    const idleEvent = { type: "session.idle", data: { sessionID: "s1" } } as unknown;
    (ctx.event as unknown as { subscribe: () => AsyncIterable<unknown> }).subscribe = () =>
      (async function* () {
        yield idleEvent;
      })();
    const setup = await serverPlugin.setup(ctx as never);

    // Allow the detached event loop to process the event.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await setup?.();

    const state = await readPluginState(tmpDir);
    expect(state?.lastBudgetSnapshot?.primary.spend).toBe(3.21);
    expect(state?.budgetRefreshedAt).toEqual(expect.any(Number));
    vi.unstubAllGlobals();
  });
});
describe("triangulation: alternate v2 wiring cases", () => {
  const savedEnv: { url?: string; stateDir?: string; dataHome?: string } = {};
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "actsis-litellm-tri-"));
    savedEnv.url = process.env.ACTSIS_LITELLM_URL;
    savedEnv.stateDir = process.env.ACTSIS_LITELLM_STATE_DIR;
    savedEnv.dataHome = process.env.XDG_DATA_HOME;
    delete process.env.ACTSIS_LITELLM_URL;
    process.env.ACTSIS_LITELLM_STATE_DIR = tmpDir;
    process.env.XDG_DATA_HOME = tmpDir;
  });

  afterEach(async () => {
    if (savedEnv.url !== undefined) process.env.ACTSIS_LITELLM_URL = savedEnv.url;
    else delete process.env.ACTSIS_LITELLM_URL;
    if (savedEnv.stateDir !== undefined) process.env.ACTSIS_LITELLM_STATE_DIR = savedEnv.stateDir;
    else delete process.env.ACTSIS_LITELLM_STATE_DIR;
    if (savedEnv.dataHome !== undefined) process.env.XDG_DATA_HOME = savedEnv.dataHome;
    else delete process.env.XDG_DATA_HOME;
    vi.unstubAllGlobals();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("options.providerId overrides the provider/integration ID end to end", async () => {
    const { ctx, providers, commands, methods } = makeFakeContext({ providerId: "custom-gw" });
    await serverPlugin.setup(ctx as never);

    expect(providers[0].info.id).toBe("custom-gw");
    expect(providers[0].info.integrationID).toBe("custom-gw");
    expect(methods.every((m: Record<string, unknown>) => m.integrationID === "custom-gw")).toBe(true);
    expect(commands.every((c) => c.name.startsWith("actsis-litellm-"))).toBe(true);
  });

  it("options.requestTimeoutMs and catalogTtlMinutes flow into the closure", async () => {
    const closure = await resolveClosure({ requestTimeoutMs: 1234, catalogTtlMinutes: 1 });
    expect(closure.requestTimeoutMs).toBe(1234);
    expect(closure.catalogTtlMs).toBe(60_000);
  });

  it("cleanup aborts the event loop without throwing", async () => {
    const { ctx } = makeFakeContext();
    const cleanup = await serverPlugin.setup(ctx as never);
    await expect(cleanup?.()).resolves.toBeUndefined();
    await expect(cleanup?.()).resolves.toBeUndefined();
  });

  it("the context hook normalizes v1 string thinking values", async () => {
    const { ctx, hooks } = makeFakeContext();
    await serverPlugin.setup(ctx as never);

    const options: Record<string, unknown> = { thinking: "off" };
    await hooks["context"].callback({ options });
    expect(options.thinking).toEqual({ type: "disabled" });
  });

  it("buildCommandDefinitions skips already-registered command names", () => {
    const commands = buildCommandDefinitions([{ name: "actsis-litellm-status" }]);
    expect(commands.map((c) => c.name)).toEqual([
      "actsis-litellm-models",
      "actsis-litellm-budget",
      "actsis-litellm-logout",
    ]);
  });

  it("buildProviderInfo strips a trailing /v1 from the resolved base URL", async () => {
    const closure = await resolveClosure({ url: "https://gw.example.com/v1" });
    expect(closure.baseUrl).toBe("https://gw.example.com");
    const info = buildProviderInfo(closure) as unknown as { settings: { baseURL: string } };
    expect(info.settings.baseURL).toBe("https://gw.example.com/v1");
  });
});

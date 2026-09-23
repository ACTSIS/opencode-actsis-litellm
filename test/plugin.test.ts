import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Config, PluginInput } from "@opencode-ai/plugin";
import type { Auth } from "@opencode-ai/sdk/v2";
import {
  buildProviderInjection,
  buildCommandTemplates,
  makeAuthFetch,
  ActsisActiveLLMPlugin,
  resolveClosure,
} from "../src/plugin.ts";
import { writePluginState, readPluginState } from "../src/state.ts";
import type { OpencodeModelConfig } from "../src/catalog-cache.ts";
import type { createOpencodeClient } from "@opencode-ai/sdk";

type TestInput = PluginInput & { client: ReturnType<typeof createOpencodeClient> };

function makeInput(): TestInput {
  return {
    client: {
      auth: { set: vi.fn(async () => true) } as unknown as ReturnType<typeof createOpencodeClient>["auth"],
      app: { log: vi.fn(async () => undefined) } as unknown as ReturnType<typeof createOpencodeClient>["app"],
      tui: { showToast: vi.fn(async () => undefined) } as unknown as ReturnType<typeof createOpencodeClient>["tui"],
    } as unknown as ReturnType<typeof createOpencodeClient>,
    project: {} as unknown as TestInput["project"],
    directory: ".",
    worktree: ".",
    experimental_workspace: { register: vi.fn() },
    serverUrl: new URL("http://localhost:1234"),
    $: {} as unknown as TestInput["$"],
  };
}

describe("buildProviderInjection", () => {
  it("creates a provider entry when none exists", () => {
    const config: Config = {};
    const model: OpencodeModelConfig = {
      name: "gpt-4",
      tool_call: true,
      reasoning: true,
      limit: { context: 128000, output: 16384 },
      modalities: { input: ["text"], output: ["text"] },
    };

    buildProviderInjection(config, {
      providerId: "actsis-litellm",
      baseUrl: "https://gw.example.com",
      models: { "gpt-4": model },
    });

    expect(config.provider?.["actsis-litellm"]).toEqual({
      npm: "@ai-sdk/openai-compatible",
      name: "ACTSIS LiteLLM",
      options: { baseURL: "https://gw.example.com/v1", apiKey: "" },
      models: { "gpt-4": model },
    });
  });

  it("preserves existing npm/name and merges models", () => {
    const existingModel: OpencodeModelConfig = {
      name: "existing",
      tool_call: false,
      reasoning: false,
      limit: { context: 1000, output: 1000 },
      modalities: { input: ["text"], output: ["text"] },
    };

    const config: Config = {
      provider: {
        "actsis-litellm": {
          npm: "custom-npm",
          name: "Custom Name",
          options: { baseURL: "https://old.example.com/v1", apiKey: "" },
          models: { existing: existingModel },
        } as unknown as NonNullable<Config["provider"]>["actsis-litellm"],
      },
    };

    const newModel: OpencodeModelConfig = {
      name: "gpt-4",
      tool_call: true,
      reasoning: true,
      limit: { context: 128000, output: 16384 },
      modalities: { input: ["text"], output: ["text"] },
    };

    buildProviderInjection(config, {
      providerId: "actsis-litellm",
      baseUrl: "https://gw.example.com",
      models: { "gpt-4": newModel },
    });

    const provider = config.provider!["actsis-litellm"] as { npm: string; name: string; options: { baseURL: string }; models: Record<string, OpencodeModelConfig> };
    expect(provider.npm).toBe("custom-npm");
    expect(provider.name).toBe("Custom Name");
    expect(provider.models["gpt-4"]).toEqual(newModel);
    expect(provider.models["existing"]).toEqual(existingModel);
  });
});

describe("buildCommandTemplates", () => {
  it("injects all three command templates when config.command is empty", () => {
    const commands = buildCommandTemplates(undefined);
    expect(Object.keys(commands)).toEqual(["litellm-status", "litellm-models", "litellm-logout"]);
    expect(commands["litellm-status"].template).toContain("litellm_status tool");
    expect(commands["litellm-models"].description).toContain("Force-sync");
  });

  it("does not overwrite user-defined commands", () => {
    const existing = {
      "litellm-status": { template: "user template", description: "user desc" },
      "other-command": { template: "other", description: "other" },
    };
    const commands = buildCommandTemplates(existing);
    expect(commands["litellm-status"]).toBeUndefined();
    expect(commands["litellm-models"]).toBeDefined();
    expect(commands["litellm-logout"]).toBeDefined();
    expect(existing["litellm-status"].template).toBe("user template");
  });
});

describe("ActsisActiveLLMPlugin auth hook structure", () => {
  it("exposes oauth and api methods with gatewayUrl prompts", async () => {
    const hooks = await ActsisActiveLLMPlugin(makeInput(), { url: "https://gw.example.com" });
    expect(hooks.auth).toBeDefined();
    expect(hooks.auth!.provider).toBe("actsis-litellm");
    expect(hooks.auth!.methods).toHaveLength(2);

    const oauth = hooks.auth!.methods.find((m) => m.type === "oauth")!;
    expect(oauth.label).toBe("Sign in with SSO (browser)");
    const oauthPrompts = oauth.prompts as Array<{ key: string }>;
    expect(oauthPrompts[0].key).toBe("gatewayUrl");

    const api = hooks.auth!.methods.find((m) => m.type === "api")!;
    expect(api.label).toBe("Use an API key");
    const apiPrompts = api.prompts as Array<{ key: string }>;
    expect(apiPrompts.map((p) => p.key)).toEqual(["gatewayUrl"]);
  });
});

describe("api method authorize", () => {
  let stateDir: string;
  const savedEnv: { url?: string; stateDir?: string } = {};

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(os.tmpdir(), "actsis-litellm-test-"));
    savedEnv.url = process.env.ACTSIS_LITELLM_URL;
    savedEnv.stateDir = process.env.ACTSIS_LITELLM_STATE_DIR;
    delete process.env.ACTSIS_LITELLM_URL;
    process.env.ACTSIS_LITELLM_STATE_DIR = stateDir;
  });

  afterEach(async () => {
    if (savedEnv.url !== undefined) {
      process.env.ACTSIS_LITELLM_URL = savedEnv.url;
    } else {
      delete process.env.ACTSIS_LITELLM_URL;
    }
    if (savedEnv.stateDir !== undefined) {
      process.env.ACTSIS_LITELLM_STATE_DIR = savedEnv.stateDir;
    } else {
      delete process.env.ACTSIS_LITELLM_STATE_DIR;
    }
    await rm(stateDir, { recursive: true, force: true });
  });

  it("records the gateway URL and auth mode, returning success without a key", async () => {
    const hooks = await ActsisActiveLLMPlugin(makeInput(), { url: "https://configured.example.com" });
    const api = hooks.auth!.methods.find((m) => m.type === "api")!;
    const authorize = api.authorize as (inputs?: Record<string, string>) => Promise<{ type: string; key?: string }>;

    const result = await authorize({ gatewayUrl: "https://gw.example.com" });

    expect(result.type).toBe("success");
    expect(result).not.toHaveProperty("key");

    const state = await readPluginState(stateDir);
    expect(state?.authMode).toBe("api_key");
    expect(state?.gatewayUrl).toBe("https://gw.example.com");
  });

  it("returns failed when no gateway URL is resolvable", async () => {
    const hooks = await ActsisActiveLLMPlugin(makeInput());
    const api = hooks.auth!.methods.find((m) => m.type === "api")!;
    const authorize = api.authorize as (inputs?: Record<string, string>) => Promise<{ type: string }>;

    const result = await authorize({});

    expect(result.type).toBe("failed");
  });
});

describe("auth loader", () => {
  let stateDir: string;
  const savedEnv: { url?: string; stateDir?: string } = {};

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(os.tmpdir(), "actsis-litellm-test-"));
    savedEnv.url = process.env.ACTSIS_LITELLM_URL;
    savedEnv.stateDir = process.env.ACTSIS_LITELLM_STATE_DIR;
    delete process.env.ACTSIS_LITELLM_URL;
    process.env.ACTSIS_LITELLM_STATE_DIR = stateDir;
  });

  afterEach(async () => {
    if (savedEnv.url !== undefined) {
      process.env.ACTSIS_LITELLM_URL = savedEnv.url;
    } else {
      delete process.env.ACTSIS_LITELLM_URL;
    }
    if (savedEnv.stateDir !== undefined) {
      process.env.ACTSIS_LITELLM_STATE_DIR = savedEnv.stateDir;
    } else {
      delete process.env.ACTSIS_LITELLM_STATE_DIR;
    }
    await rm(stateDir, { recursive: true, force: true });
  });

  it("returns an empty object when getAuth throws", async () => {
    const hooks = await ActsisActiveLLMPlugin(makeInput(), { url: "https://gw.example.com" });
    const loader = hooks.auth!.loader!;
    const result = await loader(async () => {
      throw new Error("no auth");
    });
    expect(result).toEqual({});
  });

  it("returns apiKey, baseURL and fetch for api auth", async () => {
    const hooks = await ActsisActiveLLMPlugin(makeInput(), { url: "https://gw.example.com" });
    const loader = hooks.auth!.loader!;
    const auth: Auth = { type: "api", key: "sk-test" };
    const result = await loader(async () => auth);
    expect(result.apiKey).toBe("sk-test");
    expect(result.baseURL).toBe("https://gw.example.com/v1");
    expect(result.fetch).toBeDefined();
  });

  it("returns apiKey and fetch for oauth auth", async () => {
    const hooks = await ActsisActiveLLMPlugin(makeInput(), { url: "https://gw.example.com" });
    const loader = hooks.auth!.loader!;
    const auth: Auth = { type: "oauth", access: "access-1", refresh: "refresh-1", expires: Date.now() + 3600_000 };
    const result = await loader(async () => auth);
    expect(result.apiKey).toBe("");
    expect(result.baseURL).toBe("https://gw.example.com/v1");
    expect(result.fetch).toBeDefined();
  });

  it("prefers the options URL over a state file gatewayUrl for the same provider", async () => {
    await writePluginState(
      { version: 1, gatewayUrl: "http://statefile.invalid", providerId: "actsis-litellm" },
      stateDir,
    );
    const hooks = await ActsisActiveLLMPlugin(makeInput(), { url: "https://options.invalid" });
    const loader = hooks.auth!.loader!;
    const auth: Auth = { type: "api", key: "sk-test" };
    const result = await loader(async () => auth);
    expect(result.baseURL).toBe("https://options.invalid/v1");
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

describe("resolveClosure", () => {
  it("reads env URL over options and stored URL", async () => {
    const original = process.env.ACTSIS_LITELLM_URL;
    process.env.ACTSIS_LITELLM_URL = "https://env.example.com";
    try {
      const closure = await resolveClosure(makeInput(), { url: "https://opt.example.com" });
      expect(closure.baseUrl).toBe("https://env.example.com");
    } finally {
      process.env.ACTSIS_LITELLM_URL = original;
    }
  });

  it("falls back to options URL when env is absent", async () => {
    const original = process.env.ACTSIS_LITELLM_URL;
    delete process.env.ACTSIS_LITELLM_URL;
    try {
      const closure = await resolveClosure(makeInput(), { url: "https://opt.example.com" });
      expect(closure.baseUrl).toBe("https://opt.example.com");
    } finally {
      if (original !== undefined) process.env.ACTSIS_LITELLM_URL = original;
    }
  });
});

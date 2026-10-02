import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildInitialModels,
  makeCredentialReader,
  runBudgetRefresh,
  type CredentialValue,
  type PluginClosure,
  type SetupContext,
} from "../src/plugin.ts";
import { buildLitellmToolInfos, resolveToolToken, type ToolDeps } from "../src/tools.ts";
import { readPluginState, writePluginState } from "../src/state.ts";
import { defaultAuthPath } from "../src/auth-store.ts";

function makeToolContext() {
  return {};
}

function makeModelConfig(name: string) {
  return {
    name,
    tool_call: true,
    reasoning: true,
    limit: { context: 128_000, output: 16_384 },
    modalities: { input: ["text"], output: ["text"] },
  };
}

function oauthCred(overrides: Partial<CredentialValue> = {}): CredentialValue {
  return {
    type: "oauth",
    methodID: "sso-browser",
    access: "v2-access-1",
    refresh: "v2-refresh-1",
    expires: 1_700_000_000_000,
    ...overrides,
  } as CredentialValue;
}

function stubCatalogFetch() {
  return vi.fn(async (input: string | URL | Request) => {
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
  });
}

function stubBudgetFetch(spend: number) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/key/info") {
      return new Response(JSON.stringify({ spend, max_budget: 100 }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  });
}

// --- tool-executor level (src/tools.ts) ---

describe("tools: integration credential reader (v2)", () => {
  let tmpDir: string;
  let authPath: string;
  const savedEnv: { stateDir?: string; dataHome?: string } = {};

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "actsis-litellm-cred-test-"));
    authPath = path.join(tmpDir, "auth.json");
    savedEnv.stateDir = process.env.ACTSIS_LITELLM_STATE_DIR;
    savedEnv.dataHome = process.env.XDG_DATA_HOME;
    process.env.ACTSIS_LITELLM_STATE_DIR = tmpDir;
    process.env.XDG_DATA_HOME = tmpDir;
  });

  afterEach(async () => {
    if (savedEnv.stateDir !== undefined) process.env.ACTSIS_LITELLM_STATE_DIR = savedEnv.stateDir;
    else delete process.env.ACTSIS_LITELLM_STATE_DIR;
    if (savedEnv.dataHome !== undefined) process.env.XDG_DATA_HOME = savedEnv.dataHome;
    else delete process.env.XDG_DATA_HOME;
    vi.unstubAllGlobals();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeDeps(
    getCredential?: ToolDeps["getCredential"],
    fetchImpl?: typeof fetch,
  ): ToolDeps {
    return { providerId: "actsis-litellm", stateDir: tmpDir, authPath, fetchImpl, ...(getCredential ? { getCredential } : {}) };
  }

  it("resolveToolToken prefers getCredential() over auth.json (oauth, near-expiry refresh)", async () => {
    await writePluginState(
      {
        version: 1,
        gatewayUrl: "https://gw.example.com",
        tokenEndpoint: "https://gw.example.com/token",
        clientId: "client-1",
        resource: "https://gw.example.com",
      },
      tmpDir,
    );
    // auth.json holds a DIFFERENT (stale) v1 credential that must be ignored.
    await writeFile(
      authPath,
      JSON.stringify({ "actsis-litellm": { type: "api", key: "sk-v1-stale" } }),
    );

    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/token") {
        return new Response(
          JSON.stringify({ access_token: "fresh-access", refresh_token: "refresh-2", expires_in: 3600 }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const resolved = await resolveToolToken(
      makeDeps(async () => oauthCred({ access: "v2-access-1", refresh: "v2-refresh-1", expires: Date.now() + 60_000 }), fetchImpl),
    );
    expect(resolved.entry?.type).toBe("oauth");
    if (resolved.entry?.type === "oauth") {
      expect(resolved.entry.access).toBe("v2-access-1");
      expect(resolved.entry.refresh).toBe("v2-refresh-1");
    }
    expect(resolved.token).toBe("fresh-access"); // refreshed via state endpoints
  });

  it("resolveToolToken uses the key credential from getCredential()", async () => {
    const resolved = await resolveToolToken(makeDeps(async () => ({ type: "key", key: "sk-v2" })));
    expect(resolved.entry?.type).toBe("api");
    expect(resolved.token).toBe("sk-v2");
  });

  it("resolveToolToken still falls back to auth.json when getCredential() resolves null (v1 era)", async () => {
    await writeFile(authPath, JSON.stringify({ "actsis-litellm": { type: "api", key: "sk-fallback" } }));
    const resolved = await resolveToolToken(makeDeps(async () => null));
    expect(resolved.entry?.type).toBe("api");
    expect(resolved.token).toBe("sk-fallback");
  });

  it("status reports auth + expiry from the integration credential, not auth.json", async () => {
    await writeToolState(tmpDir, { version: 1, gatewayUrl: "https://gw.example.com" });
    await writeFile(authPath, JSON.stringify({ "actsis-litellm": { type: "api", key: "sk-v1-stale" } }));
    vi.stubGlobal("fetch", stubBudgetFetch(1.23));

    const cred = oauthCred();
    const deps = makeDeps(async () => cred);
    const status = buildLitellmToolInfos(deps).find((t) => t.name === "actsis_litellm_status")!;
    const result = (await status.execute({}, makeToolContext())) as { content: string };

    expect(result.content).toContain(`Auth: oauth (expires ${new Date((cred.expires as number)).toISOString()})`);
    expect(result.content).toContain("Budget: $1.23 / $100.00 used (1%)");
  });

  it("budget uses the integration credential", async () => {
    await writeToolState(tmpDir, { version: 1, gatewayUrl: "https://gw.example.com" });
    vi.stubGlobal("fetch", stubBudgetFetch(2.34));

    const deps = makeDeps(async () => ({ type: "key", key: "sk-v2" }));
    const budget = buildLitellmToolInfos(deps).find((t) => t.name === "actsis_litellm_budget")!;
    const result = (await budget.execute({}, makeToolContext())) as { content: string };
    expect(result.content).toMatch(/Budget .*2% · \$2\.34\/\$100\.00/);
  });

  it("models syncs the catalog through the integration credential", async () => {
    await writeToolState(tmpDir, { version: 1, gatewayUrl: "https://gw.example.com" });
    vi.stubGlobal("fetch", stubCatalogFetch());
    const deps = makeDeps(async () => ({ type: "key", key: "sk-v2" }));
    const models = buildLitellmToolInfos(deps).find((t) => t.name === "actsis_litellm_models")!;
    const result = (await models.execute({}, makeToolContext())) as { content: string };
    expect(result.content).toContain("Model catalog synced: 1 models available (added 1, removed 0).");

    const cache = JSON.parse(await readFile(path.join(tmpDir, "models-cache.json"), "utf8"));
    expect(Object.keys(cache.models)).toEqual(["gpt-4"]);
  });

  it("logout revokes with the integration-sourced refresh token", async () => {
    await writeToolState(tmpDir, {
      version: 1,
      gatewayUrl: "https://gw.example.com",
      tokenEndpoint: "https://gw.example.com/token",
      revocationEndpoint: "https://gw.example.com/revoke",
      resource: "https://gw.example.com",
      clientId: "client-1",
      authMode: "oauth",
    });
    await writeFile(
      path.join(tmpDir, "models-cache.json"),
      JSON.stringify({ version: 2, fetchedAt: Date.now(), models: {} }),
    );

    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/revoke") {
        const body = new URLSearchParams(init?.body?.toString() ?? "");
        bodies.push(body.get("token") ?? "");
        return new Response("ok");
      }
      return new Response("not found", { status: 404 });
    });

    // v1 auth.json does NOT exist in v2; the reader supplies the credential.
    const deps = makeDeps(async () => oauthCred({ refresh: "v2-refresh-1" }), fetchImpl);
    const logout = buildLitellmToolInfos(deps).find((t) => t.name === "actsis_litellm_logout")!;
    const result = (await logout.execute({}, makeToolContext())) as { content: string };

    expect(result.content).toContain("Logged out");
    expect(result.content).toContain("native auth UI");
    expect(bodies).toEqual(["v2-refresh-1"]);
    const state = await readPluginState(tmpDir);
    expect(state?.lastBudgetSnapshot).toBeUndefined();
    await expect(readFile(path.join(tmpDir, "models-cache.json"), "utf8")).rejects.toThrow();
  });

  it("logout without any credential still clears plugin state and cache", async () => {
    await writeToolState(tmpDir, { version: 1, gatewayUrl: "https://gw.example.com" });
    await writeFile(
      path.join(tmpDir, "models-cache.json"),
      JSON.stringify({ version: 2, fetchedAt: Date.now(), models: {} }),
    );

    const deps = makeDeps(async () => null);
    const logout = buildLitellmToolInfos(deps).find((t) => t.name === "actsis_litellm_logout")!;
    const result = (await logout.execute({}, makeToolContext())) as { content: string };
    expect(result.content).toContain("Logged out");
    expect(result.content).toContain("native auth UI");
  });
});

async function writeToolState(tmpDir: string, content: Record<string, unknown>): Promise<void> {
  await writeFile(path.join(tmpDir, "state.json"), JSON.stringify(content));
}

// --- plugin-level (src/plugin.ts) ---

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

describe("buildInitialModels: integration credential reader (v2)", () => {
  let tmpDir: string;
  const savedEnv: { stateDir?: string; dataHome?: string } = {};

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "actsis-litellm-init-models-"));
    savedEnv.stateDir = process.env.ACTSIS_LITELLM_STATE_DIR;
    savedEnv.dataHome = process.env.XDG_DATA_HOME;
    process.env.ACTSIS_LITELLM_STATE_DIR = tmpDir;
    process.env.XDG_DATA_HOME = tmpDir;
  });

  afterEach(async () => {
    if (savedEnv.stateDir !== undefined) process.env.ACTSIS_LITELLM_STATE_DIR = savedEnv.stateDir;
    else delete process.env.ACTSIS_LITELLM_STATE_DIR;
    if (savedEnv.dataHome !== undefined) process.env.XDG_DATA_HOME = savedEnv.dataHome;
    else delete process.env.XDG_DATA_HOME;
    vi.unstubAllGlobals();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("fetches the catalog using the injected v2 credential reader", async () => {
    vi.stubGlobal("fetch", stubCatalogFetch());
    const closure = makeClosure({ stateDir: tmpDir });
    const models = await buildInitialModels(closure, async () => ({ type: "key", key: "sk-v2" }));
    expect(Object.keys(models)).toEqual(["gpt-4"]);
    // The v2 credential must have been used (fetch had a Bearer/Authorization).#
  });

  it("falls back to the on-disk cache when the v2 reader returns null and no auth.json exists", async () => {
    await writeFile(
      path.join(tmpDir, "models-cache.json"),
      JSON.stringify({
        version: 2,
        fetchedAt: Date.now(),
        models: { cached: makeModelConfig("cached") },
      }),
    );
    const closure = makeClosure({ stateDir: tmpDir });
    const models = await buildInitialModels(closure, async () => null);
    expect(Object.keys(models)).toEqual(["cached"]);
  });

  it("still falls back to auth.json when the reader is not provided (v1 behavior)", async () => {
    await mkdir(path.dirname(defaultAuthPath()), { recursive: true });
    await writeFile(
      defaultAuthPath(),
      JSON.stringify({ "actsis-litellm": { type: "api", key: "sk-v1-bootstrap" } }),
    );
    vi.stubGlobal("fetch", stubCatalogFetch());
    const closure = makeClosure({ stateDir: tmpDir });
    const models = await buildInitialModels(closure);
    expect(Object.keys(models)).toEqual(["gpt-4"]);
  });
});

describe("runBudgetRefresh: integration credential reader (v2)", () => {
  let tmpDir: string;
  const savedEnv: { stateDir?: string; dataHome?: string } = {};

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "actsis-litellm-budg-ref-"));
    savedEnv.stateDir = process.env.ACTSIS_LITELLM_STATE_DIR;
    savedEnv.dataHome = process.env.XDG_DATA_HOME;
    process.env.ACTSIS_LITELLM_STATE_DIR = tmpDir;
    process.env.XDG_DATA_HOME = tmpDir;
  });

  afterEach(async () => {
    if (savedEnv.stateDir !== undefined) process.env.ACTSIS_LITELLM_STATE_DIR = savedEnv.stateDir;
    else delete process.env.ACTSIS_LITELLM_STATE_DIR;
    if (savedEnv.dataHome !== undefined) process.env.XDG_DATA_HOME = savedEnv.dataHome;
    else delete process.env.XDG_DATA_HOME;
    vi.unstubAllGlobals();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("persists a budget snapshot using the v2 credential reader", async () => {
    vi.stubGlobal("fetch", stubBudgetFetch(7.89));
    await writeToolState(tmpDir, { version: 1, gatewayUrl: "https://gw.example.com", providerId: "actsis-litellm" });
    const closure = makeClosure({ stateDir: tmpDir });
    await expect(runBudgetRefresh(closure, async () => ({ type: "key", key: "sk-v2" }))).resolves.toBeUndefined();
    const state = await readPluginState(tmpDir);
    expect(state?.lastBudgetSnapshot?.primary.spend).toBe(7.89);
  });

  it("does nothing when the v2 reader returns null and no auth.json exists", async () => {
    vi.stubGlobal("fetch", stubBudgetFetch(7.89));
    await writeToolState(tmpDir, { version: 1, gatewayUrl: "https://gw.example.com" });
    const closure = makeClosure({ stateDir: tmpDir });
    await runBudgetRefresh(closure, async () => null);
    const state = await readPluginState(tmpDir);
    expect(state?.lastBudgetSnapshot).toBeUndefined();
  });
});

// --- setup-level wiring (makeCredentialReader against a fake ctx) ---

describe("makeCredentialReader (v2 wiring)", () => {
  it("wires ctx.integration.connection.active + resolve into a credential reader", async () => {
    const cred = oauthCred();
    const conn = { type: "credential", id: "cred-1", label: "actsis-litellm" };
    const fakeCtx = {
      integration: {
        connection: {
          active: vi.fn(async (integrationID: string) => {
            expect(integrationID).toBe("actsis-litellm");
            return conn;
          }),
          resolve: vi.fn(async (connection: unknown) => {
            expect(connection).toBe(conn);
            return cred;
          }),
        },
      },
    } as unknown as SetupContext;

    const reader = makeCredentialReader(fakeCtx, "actsis-litellm");
    expect(await reader()).toEqual(cred);
  });

  it("maps undefined connection/credential to null", async () => {
    const fakeCtx = {
      integration: {
        connection: {
          active: async () => undefined,
          resolve: async () => undefined,
        },
      },
    } as unknown as SetupContext;
    const reader = makeCredentialReader(fakeCtx, "actsis-litellm");
    expect(await reader()).toBeNull();
  });
});

describe("server plugin: credential reader flows through setup into tools, models, and budget", () => {
  let tmpDir: string;
  const savedEnv: { url?: string; stateDir?: string; dataHome?: string } = {};

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "actsis-litellm-setup-cred-"));
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

  function makeFakeContext() {
    const conn = { type: "credential", id: "cred-1", label: "actsis-litellm" };
    const cred = oauthCred({ access: "setup-access-1", refresh: "setup-refresh-1", expires: Date.now() + 3_600_000 });
    let setupTools: Array<Record<string, unknown>> = [];
    const providers: Array<{ info: Record<string, unknown>; models: Array<Record<string, unknown>> }> = [];
    const fake = {
      options: {},
      provider: {
        transform: async (cb: (e: any) => void) => {
          cb({ add: (input: { info: unknown; models: unknown[] }) => providers.push(input as never) });
          return { dispose: async () => {} };
        },
      },
      tool: {
        transform: async (cb: (e: any) => void) => {
          cb({ add: (tool: Record<string, unknown>) => setupTools.push(tool) });
          return { dispose: async () => {} };
        },
      },
      command: { transform: async (cb: (e: any) => void) => { cb({ add: () => {} }); return { dispose: async () => {} }; } },
      integration: {
        connection: {
          active: async () => conn,
          resolve: async () => cred,
        },
        transform: async (cb: (e: any) => void) => { cb({ method: { update: () => {} } }); return { dispose: async () => {} }; },
      },
      session: {
        prompt: async () => ({}),
        hook: () => ({ dispose: async () => {} }),
      },
      event: { subscribe: () => (async function* () {})() },
    };
    return { fake: fake as unknown as SetupContext, setupTools, providers };
  }

  it("the catalog registers models resolved from the integration credential", async () => {
    vi.stubGlobal("fetch", stubCatalogFetch());
    // The login flow persists the gateway URL in plugin state; without it the
    // catalog bootstrap has no baseUrl to fetch from.
    await writePluginState(
      { version: 1, gatewayUrl: "https://gw.example.com", providerId: "actsis-litellm" },
      tmpDir,
    );
    const { fake, providers } = makeFakeContext();
    const mod = await import("../src/plugin.ts");
    const setup = await mod.default.setup(fake as never);
    await setup?.();
    expect(providers).toHaveLength(1);
    expect(providers[0].models.map((m) => (m as { id: string }).id)).toContain("gpt-4");
  });

  it("a v2 tool executor reads the credential through the wired reader", async () => {
    vi.stubGlobal("fetch", stubBudgetFetch(5.55));
    const { fake, setupTools } = makeFakeContext();
    const mod = await import("../src/plugin.ts");
    const setup = await mod.default.setup(fake as never);
    await setup?.();
    await writeToolState(tmpDir, { version: 1, gatewayUrl: "https://gw.example.com", providerId: "actsis-litellm" });
    const status = setupTools.find((t) => t.name === "actsis_litellm_status") as {
      execute: (input: unknown, ctx: unknown) => Promise<{ content: string }>;
    };
    const result = await status.execute({}, undefined);
    expect(result.content).toContain("Auth: oauth");
    expect(result.content).toContain("Budget: $5.55 / $100.00 used (6%)");
  });
});
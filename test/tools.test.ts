import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildLitellmToolInfos, resolveToolToken, type ToolDeps } from "../src/tools.ts";
import { readPluginState, writePluginState } from "../src/state.ts";
import { defaultAuthPath } from "../src/auth-store.ts";
import type { ToolContext } from "@opencode/plugin/promise/tool";

function makeToolContext(): ToolContext {
  return {
    sessionID: "session-1" as ToolContext["sessionID"],
    messageID: "msg-1" as ToolContext["messageID"],
    agent: "agent-1" as ToolContext["agent"],
    id: "call-1" as ToolContext["id"],
    progress: async () => {},
  };
}

describe("buildLitellmToolInfos", () => {
  it("exposes the four litellm tools in v2 shape", () => {
    const infos = buildLitellmToolInfos({ providerId: "actsis-litellm" });
    expect(infos.map((t) => t.name)).toEqual([
      "actsis_litellm_status",
      "actsis_litellm_budget",
      "actsis_litellm_models",
      "actsis_litellm_logout",
    ]);

    for (const info of infos) {
      expect(typeof info.description).toBe("string");
      expect(info.description.length).toBeGreaterThan(0);
      expect(info.input).toEqual({ type: "object", properties: {}, additionalProperties: false });
      expect(typeof info.execute).toBe("function");
    }
  });
});

describe("resolveToolToken", () => {
  let tmpDir: string;
  let authPath: string;
  const savedEnv: { stateDir?: string; dataHome?: string } = {};

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "actsis-litellm-tools-test-"));
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
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeDeps(fetchImpl?: typeof fetch): ToolDeps {
    return { providerId: "actsis-litellm", stateDir: tmpDir, authPath, fetchImpl };
  }

  it("resolves the API key when an api credential is stored", async () => {
    await writeFile(
      path.join(tmpDir, "state.json"),
      JSON.stringify({ version: 1, gatewayUrl: "https://gw.example.com" }),
    );
    await writeFile(
      authPath,
      JSON.stringify({ "actsis-litellm": { type: "api", key: "sk-test" } }),
    );

    const resolved = await resolveToolToken(makeDeps());
    expect(resolved.state?.gatewayUrl).toBe("https://gw.example.com");
    expect(resolved.token).toBe("sk-test");
    expect(resolved.entry?.type).toBe("api");
  });

  it("resolves the current access token for oauth credentials", async () => {
    await writeFile(
      path.join(tmpDir, "state.json"),
      JSON.stringify({ version: 1, gatewayUrl: "https://gw.example.com" }),
    );
    await writeFile(
      authPath,
      JSON.stringify({
        "actsis-litellm": {
          type: "oauth",
          access: "access-1",
          refresh: "refresh-1",
          expires: Date.now() + 3600_000,
        },
      }),
    );

    const resolved = await resolveToolToken(makeDeps());
    expect(resolved.token).toBe("access-1");
    expect(resolved.entry?.type).toBe("oauth");
  });

  it("refreshes an expiring oauth token via the gateway (no plugin-side persistence)", async () => {
    await writeFile(
      path.join(tmpDir, "state.json"),
      JSON.stringify({
        version: 1,
        gatewayUrl: "https://gw.example.com",
        tokenEndpoint: "https://gw.example.com/token",
        clientId: "client-1",
        resource: "https://gw.example.com",
      }),
    );
    await writeFile(
      authPath,
      JSON.stringify({
        "actsis-litellm": {
          type: "oauth",
          access: "stale-access",
          refresh: "refresh-1",
          expires: Date.now() + 60_000,
        },
      }),
    );

    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/token") {
        expect(new Headers(init?.headers).get("Content-Type")).toBe(
          "application/x-www-form-urlencoded",
        );
        return new Response(
          JSON.stringify({
            access_token: "fresh-access",
            refresh_token: "refresh-2",
            expires_in: 3600,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const resolved = await resolveToolToken(makeDeps(fetchImpl));
    expect(resolved.token).toBe("fresh-access");
  });

  it("returns nulls when no credential is stored", async () => {
    const resolved = await resolveToolToken(makeDeps());
    expect(resolved.entry).toBeNull();
    expect(resolved.token).toBeNull();
    expect(resolved.state).toBeNull();
  });
});

async function writeToolState(tmpDir: string, content: Record<string, unknown>): Promise<void> {
  await writeFile(path.join(tmpDir, "state.json"), JSON.stringify(content));
}

async function writeApiKey(authPath: string): Promise<void> {
  await writeFile(
    authPath,
    JSON.stringify({ "actsis-litellm": { type: "api", key: "sk-test" } }),
  );
}

function stubGateway(spend: number | null = 1.23, maxBudget: number | null = 10) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/key/info") {
      return new Response(JSON.stringify({ spend, max_budget: maxBudget }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  });
}

describe("actsis_litellm_status", () => {
  let tmpDir: string;
  let authPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "actsis-litellm-status-test-"));
    authPath = path.join(tmpDir, "auth.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeDeps(fetchImpl?: typeof fetch): ToolDeps {
    return { providerId: "actsis-litellm", stateDir: tmpDir, authPath, fetchImpl };
  }

  function statusExecute(deps: ToolDeps) {
    const info = buildLitellmToolInfos(deps).find((t) => t.name === "actsis_litellm_status")!;
    return (input: Record<string, unknown>) =>
      info.execute(input, makeToolContext()) as Promise<{ content: string }>;
  }

  it("composes status lines with no state, auth, or cache", async () => {
    const result = await statusExecute(makeDeps())({});
    expect(result.content).toContain("Provider: actsis-litellm");
    expect(result.content).toContain("Auth: none");
    expect(result.content).toContain("Catalog: 0 models cached");
    expect(result.content).toContain("Gateway URL: not configured");
    expect(result.content).toContain("Budget: unavailable");
  });

  it("reports credential rejection on auth failure from the gateway", async () => {
    await writeToolState(tmpDir, { version: 1, gatewayUrl: "https://gw.example.com" });
    await writeFile(authPath, JSON.stringify({ "actsis-litellm": { type: "api", key: "sk-rejected" } }));

    const fetchImpl = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    const result = await statusExecute(makeDeps(fetchImpl))({});

    expect(result.content).toContain("Budget: Credential rejected — run /login again");
  });

  it("reports generic budget failure with the error reason", async () => {
    await writeToolState(tmpDir, { version: 1, gatewayUrl: "https://gw.example.com" });
    await writeApiKey(authPath);

    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });

    const result = await statusExecute(makeDeps(fetchImpl))({});
    const budgetLine = result.content.split("\n").find((line) => line.startsWith("Budget"));
    expect(budgetLine).toBeDefined();
    expect(budgetLine).toMatch(/^Budget unavailable: /);
    expect(budgetLine).toContain("network down");
  });

  it("appends the cached budget line after a generic failure when a snapshot is stored", async () => {
    await writeToolState(tmpDir, {
      version: 1,
      gatewayUrl: "https://gw.example.com",
      lastBudgetSnapshot: {
        primary: { spend: 3.5, maxBudget: 20, tpmLimit: null, rpmLimit: null, budgetResetAt: null, keyAlias: null },
        ownKeys: [],
        source: "key_info",
      },
      budgetRefreshedAt: Date.now() - 90_000,
    });
    await writeApiKey(authPath);

    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });

    const result = await statusExecute(makeDeps(fetchImpl))({});
    expect(result.content).toContain("Budget unavailable: ");
    expect(result.content).toContain("network down");
    expect(result.content).toMatch(/Budget \(cached \d+s ago\): \$3\.50 \/ \$20\.00 used \(18%\)/);
  });

  it("shows oauth expiry and budget line from gateway", async () => {
    await writeFile(
      authPath,
      JSON.stringify({
        "actsis-litellm": {
          type: "oauth",
          access: "access-1",
          refresh: "refresh-1",
          expires: 1_700_000_000_000,
        },
      }),
    );
    await writeToolState(tmpDir, { version: 1, gatewayUrl: "https://gw.example.com" });
    await writeFile(
      path.join(tmpDir, "models-cache.json"),
      JSON.stringify({
        version: 2,
        fetchedAt: Date.now(),
        models: {
          "gpt-4": { name: "gpt-4", tool_call: true, reasoning: true, limit: { context: 128000, output: 16384 }, modalities: { input: ["text"], output: ["text"] } },
        },
      }),
    );

    const fetchImpl = stubGateway();

    const result = await statusExecute(makeDeps(fetchImpl))({});

    expect(result.content).toContain("Auth: oauth");
    expect(result.content).toContain("Catalog: 1 models cached");
    expect(result.content).toContain("Gateway URL: https://gw.example.com");
    expect(result.content).toContain("Budget: $1.23 / $10.00 used (12%)");
  });

  it("refreshes OAuth and shows the caller's key budget with own keys only", async () => {
    await writeFile(
      authPath,
      JSON.stringify({
        "actsis-litellm": {
          type: "oauth",
          access: "stale-access",
          refresh: "refresh-1",
          expires: Date.now() + 60_000,
        },
      }),
    );
    await writeToolState(tmpDir, {
      version: 1,
      gatewayUrl: "https://gw.example.com",
      tokenEndpoint: "https://gw.example.com/token",
      clientId: "client-1",
      resource: "https://gw.example.com",
    });

    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/token") {
        return new Response(
          JSON.stringify({
            access_token: "fresh-access",
            refresh_token: "refresh-2",
            expires_in: 3600,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.pathname === "/key/info") {
        // v2 does not persist refreshed tokens from tools; expect the stale
        // token here (refresh happens via the integration credential flow).
        return new Response("gateway error", { status: 500 });
      }
      if (url.pathname === "/user/info") {
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fresh-access");
        return new Response(
          JSON.stringify({
            user_id: "user-1",
            user_info: {
              spend: 29.9,
              max_budget: null,
              tpm_limit: 2_000_000,
              rpm_limit: 600,
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.pathname === "/spend/keys") {
        return new Response(
          JSON.stringify([
            { key_alias: "RPINTO", spend: 158.72, max_budget: 100, user_id: "user-1" },
            { key_alias: "OTHER", spend: 999, max_budget: 1000, user_id: "user-2" },
          ]),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const result = await statusExecute(makeDeps(fetchImpl))({});

    expect(result.content).toContain(
      "Budget: $29.90 used (no budget cap) | TPM 2,000,000 | RPM 600",
    );
    expect(result.content).toContain("Key RPINTO: $158.72 / $100.00 used (159%)");
    expect(result.content).not.toContain("OTHER");
  });
});

describe("actsis_litellm_budget", () => {
  let tmpDir: string;
  let authPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "actsis-litellm-budget-test-"));
    authPath = path.join(tmpDir, "auth.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function budgetExecute(fetchImpl?: typeof fetch) {
    const info = buildLitellmToolInfos({
      providerId: "actsis-litellm",
      stateDir: tmpDir,
      authPath,
      fetchImpl,
    }).find((t) => t.name === "actsis_litellm_budget")!;
    return (input: Record<string, unknown>) =>
      info.execute(input, makeToolContext()) as Promise<{ content: string }>;
  }

  it("returns the gauge line for a capped budget", async () => {
    await writeToolState(tmpDir, { version: 1, gatewayUrl: "https://gw.example.com" });
    await writeApiKey(authPath);

    const fetchImpl = stubGateway(12.34, 100);
    const result = await budgetExecute(fetchImpl)({});
    expect(result.content).toMatch(/Budget .*12% · \$12\.34\/\$100\.00/);
  });

  it("returns no-spend-data when spend is null", async () => {
    await writeToolState(tmpDir, { version: 1, gatewayUrl: "https://gw.example.com" });
    await writeApiKey(authPath);

    const fetchImpl = stubGateway(null);
    const result = await budgetExecute(fetchImpl)({});
    expect(result.content).toBe("no spend data (spend null)");
  });

  it("returns login prompt when no credential is stored", async () => {
    const result = await budgetExecute()({});
    expect(result.content).toBe("no credential stored — run /login");
  });

  it("returns gateway-not-configured when state has no gatewayUrl", async () => {
    await writeToolState(tmpDir, { version: 1 });
    await writeApiKey(authPath);
    const result = await budgetExecute()({});
    expect(result.content).toBe("gateway URL not configured");
  });

  it("persists the snapshot and cached timestamp on success", async () => {
    await writeToolState(tmpDir, { version: 1, gatewayUrl: "https://gw.example.com" });
    await writeApiKey(authPath);

    const fetchImpl = stubGateway(4.56, 50);
    const result = await budgetExecute(fetchImpl)({});
    expect(result.content).toMatch(/Budget .*9% · \$4\.56\/\$50\.00/);

    const state = await readPluginState(tmpDir);
    expect(state?.lastBudgetSnapshot?.primary.spend).toBe(4.56);
    expect(state?.budgetRefreshedAt).toEqual(expect.any(Number));
  });

  it("returns the AuthError message when the gateway rejects the credential", async () => {
    await writeToolState(tmpDir, { version: 1, gatewayUrl: "https://gw.example.com" });
    await writeFile(authPath, JSON.stringify({ "actsis-litellm": { type: "api", key: "sk-rejected" } }));

    const fetchImpl = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    const result = await budgetExecute(fetchImpl)({});
    expect(result.content).toBe("Credential rejected by gateway. Run /login again.");
  });

  it("returns error: <message> for other failures", async () => {
    await writeToolState(tmpDir, { version: 1, gatewayUrl: "https://gw.example.com" });
    await writeApiKey(authPath);

    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });

    const result = await budgetExecute(fetchImpl)({});
    // fetchGatewayBudget swallows the /key/info failure (non-AuthError) and
    // retries via /user/info, which surfaces the final failure reason.
    expect(result.content).toBe("error: Failed to fetch user info: network down");
  });

  it("appends the last known budget line on failure when a snapshot is cached", async () => {
    await writeToolState(tmpDir, {
      version: 1,
      gatewayUrl: "https://gw.example.com",
      lastBudgetSnapshot: {
        primary: { spend: 2.25, maxBudget: 30, tpmLimit: null, rpmLimit: null, budgetResetAt: null, keyAlias: null },
        ownKeys: [],
        source: "key_info",
      },
      budgetRefreshedAt: Date.now() - 120_000,
    });
    await writeApiKey(authPath);

    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });

    const result = await budgetExecute(fetchImpl)({});
    expect(result.content).toContain("error: ");
    expect(result.content).toContain("last known: $2.25 / $30.00 used (8%)");
  });
});

describe("actsis_litellm_models", () => {
  let tmpDir: string;
  let authPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "actsis-litellm-models-test-"));
    authPath = path.join(tmpDir, "auth.json");
    await writeToolState(tmpDir, { version: 1, gatewayUrl: "https://gw.example.com" });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function modelsExecute(fetchImpl?: typeof fetch) {
    const info = buildLitellmToolInfos({
      providerId: "actsis-litellm",
      stateDir: tmpDir,
      authPath,
      fetchImpl,
    }).find((t) => t.name === "actsis_litellm_models")!;
    return (input: Record<string, unknown>) =>
      info.execute(input, makeToolContext()) as Promise<{ content: string }>;
  }

  it("returns login prompt when not signed in", async () => {
    const result = await modelsExecute()({});
    expect(result.content).toBe("Not signed in — run /login and choose ACTSIS LiteLLM.");
  });

  it("force-syncs catalog and computes added/removed", async () => {
    await writeFile(
      path.join(tmpDir, "models-cache.json"),
      JSON.stringify({
        version: 2,
        fetchedAt: Date.now(),
        models: {
          old: { name: "old", tool_call: true, reasoning: true, limit: { context: 128000, output: 16384 }, modalities: { input: ["text"], output: ["text"] } },
        },
      }),
    );
    await writeApiKey(authPath);

    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/v1/models")) {
        return new Response(
          JSON.stringify({ data: [{ id: "new", mode: "chat" }] }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.pathname.includes("/model/info")) {
        return new Response(JSON.stringify([]), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await modelsExecute(fetchImpl)({});
    expect(result.content).toContain("Model catalog synced: 1 models available (added 1, removed 1).");

    const cache = JSON.parse(await readFile(path.join(tmpDir, "models-cache.json"), "utf8"));
    expect(Object.keys(cache.models)).toEqual(["new"]);
  });
});

describe("actsis_litellm_logout", () => {
  let tmpDir: string;
  let authPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "actsis-litellm-logout-test-"));
    authPath = path.join(tmpDir, "auth.json");
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
      authPath,
      JSON.stringify({
        "actsis-litellm": {
          type: "oauth",
          access: "access-1",
          refresh: "refresh-1",
          expires: 1_700_000_000_000,
        },
      }),
    );
    await writeFile(
      path.join(tmpDir, "models-cache.json"),
      JSON.stringify({ version: 2, fetchedAt: Date.now(), models: {} }),
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("revokes the refresh token, clears auth entry, resets state, and removes cache", async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push(url.pathname);
      if (url.pathname === "/revoke") {
        const body = new URLSearchParams(init?.body?.toString() ?? "");
        expect(body.get("token")).toBe("refresh-1");
        expect(body.get("client_id")).toBe("client-1");
        return new Response("ok");
      }
      return new Response("not found", { status: 404 });
    });

    const info = buildLitellmToolInfos({
      providerId: "actsis-litellm",
      stateDir: tmpDir,
      authPath,
      fetchImpl,
    }).find((t) => t.name === "actsis_litellm_logout")!;

    const result = (await info.execute({}, makeToolContext())) as { content: string };
    expect(result.content).toContain("Logged out. Local state and model cache cleared.");
    expect(result.content).toContain("native auth UI");
    expect(requests).toContain("/revoke");

    const authContent = JSON.parse(await readFile(authPath, "utf8"));
    expect(authContent).toEqual({});

    const stateContent = JSON.parse(await readFile(path.join(tmpDir, "state.json"), "utf8"));
    expect(stateContent).toEqual({ version: 1 });

    await expect(readFile(path.join(tmpDir, "models-cache.json"), "utf8")).rejects.toThrow();
  });
});
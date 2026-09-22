import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { buildLitellmTools } from "../src/tools.ts";
import type { PluginInput } from "@opencode-ai/plugin";
import type { createOpencodeClient } from "@opencode-ai/sdk";

type TestInput = PluginInput & { client: ReturnType<typeof createOpencodeClient> };

function makePluginInput(): TestInput {
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

function makeToolContext(): import("@opencode-ai/plugin").ToolContext {
  return {
    sessionID: "session-1",
    messageID: "msg-1",
    agent: "agent-1",
    directory: ".",
    worktree: ".",
    abort: new AbortController().signal,
    metadata: vi.fn(),
    ask: vi.fn(),
  };
}

describe("litellm_status", () => {
  let tmpDir: string;
  let authPath: string;
  let tools: ReturnType<typeof buildLitellmTools>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "actsis-litellm-tools-test-"));
    authPath = path.join(tmpDir, "auth.json");
    tools = buildLitellmTools({
      providerId: "actsis-litellm",
      getState: async () => null,
      timeout: 5_000,
      input: makePluginInput(),
      stateDir: tmpDir,
      authPath,
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("composes status lines with no state, auth, or cache", async () => {
    const output = await tools.litellm_status.execute({}, makeToolContext());
    expect(output).toContain("Provider: actsis-litellm");
    expect(output).toContain("Auth: none");
    expect(output).toContain("Catalog: 0 models cached");
    expect(output).toContain("Gateway URL: not configured");
    expect(output).toContain("Budget: unavailable");
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
    await writeFile(
      path.join(tmpDir, "state.json"),
      JSON.stringify({ version: 1, gatewayUrl: "https://gw.example.com" }),
    );
    await writeFile(
      path.join(tmpDir, "models-cache.json"),
      JSON.stringify({
        version: 1,
        fetchedAt: Date.now(),
        models: {
          "gpt-4": { name: "gpt-4", tool_call: true, reasoning: true, limit: { context: 128000, output: 16384 }, modalities: { input: ["text"], output: ["text"] } },
        },
      }),
    );

    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/key/info") {
        return new Response(JSON.stringify({ spend: 1.23, max_budget: 10 }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });

    const output = await buildLitellmTools({
      providerId: "actsis-litellm",
      getState: async () => null,
      timeout: 5_000,
      input: makePluginInput(),
      stateDir: tmpDir,
      authPath,
      fetchImpl,
    }).litellm_status.execute({}, makeToolContext());

    expect(output).toContain("Auth: oauth");
    expect(output).toContain("Catalog: 1 models cached");
    expect(output).toContain("Gateway URL: https://gw.example.com");
    expect(output).toContain("Budget: $1.23 / $10.00 used (12%)");
  });
});

describe("litellm_models", () => {
  let tmpDir: string;
  let authPath: string;
  let tools: ReturnType<typeof buildLitellmTools>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "actsis-litellm-tools-test-"));
    authPath = path.join(tmpDir, "auth.json");
    tools = buildLitellmTools({
      providerId: "actsis-litellm",
      getState: async () => null,
      timeout: 5_000,
      input: makePluginInput(),
      stateDir: tmpDir,
      authPath,
    });
    await writeFile(
      path.join(tmpDir, "state.json"),
      JSON.stringify({ version: 1, gatewayUrl: "https://gw.example.com" }),
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns login prompt when not signed in", async () => {
    const output = await tools.litellm_models.execute({}, makeToolContext());
    expect(output).toBe("Not signed in — run /login and choose ACTSIS LiteLLM.");
  });

  it("force-syncs catalog and computes added/removed", async () => {
    await writeFile(
      path.join(tmpDir, "models-cache.json"),
      JSON.stringify({
        version: 1,
        fetchedAt: Date.now(),
        models: {
          old: { name: "old", tool_call: true, reasoning: true, limit: { context: 128000, output: 16384 }, modalities: { input: ["text"], output: ["text"] } },
        },
      }),
    );
    await writeFile(
      authPath,
      JSON.stringify({
        "actsis-litellm": { type: "api", key: "sk-test" },
      }),
    );

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

    const output = await buildLitellmTools({
      providerId: "actsis-litellm",
      getState: async () => null,
      timeout: 5_000,
      input: makePluginInput(),
      stateDir: tmpDir,
      authPath,
      fetchImpl,
    }).litellm_models.execute({}, makeToolContext());

    expect(output).toContain("Model catalog synced: 1 models available (added 1, removed 1).");

    const cache = JSON.parse(await readFile(path.join(tmpDir, "models-cache.json"), "utf8"));
    expect(Object.keys(cache.models)).toEqual(["new"]);
  });
});

describe("litellm_logout", () => {
  let tmpDir: string;
  let authPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "actsis-litellm-tools-test-"));
    authPath = path.join(tmpDir, "auth.json");
    await writeFile(
      path.join(tmpDir, "state.json"),
      JSON.stringify({
        version: 1,
        gatewayUrl: "https://gw.example.com",
        tokenEndpoint: "https://gw.example.com/token",
        revocationEndpoint: "https://gw.example.com/revoke",
        resource: "https://gw.example.com",
        clientId: "client-1",
        authMode: "oauth",
      }),
    );
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
      JSON.stringify({ version: 1, fetchedAt: Date.now(), models: {} }),
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

    const tools = buildLitellmTools({
      providerId: "actsis-litellm",
      getState: async () => null,
      timeout: 5_000,
      input: makePluginInput(),
      stateDir: tmpDir,
      authPath,
      fetchImpl,
    });

    const output = await tools.litellm_logout.execute({}, makeToolContext());
    expect(output).toBe("Logged out. Credentials revoked and local state cleared.");
    expect(requests).toContain("/revoke");

    const authContent = JSON.parse(await readFile(authPath, "utf8"));
    expect(authContent).toEqual({});

    const stateContent = JSON.parse(await readFile(path.join(tmpDir, "state.json"), "utf8"));
    expect(stateContent).toEqual({ version: 1 });

    await expect(readFile(path.join(tmpDir, "models-cache.json"), "utf8")).rejects.toThrow();
  });
});

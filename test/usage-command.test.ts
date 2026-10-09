import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildLitellmToolInfos, type ToolDeps } from "../src/tools.ts";
import { parseUsageRangeArg } from "../src/usage-command.ts";

const NOW = Date.UTC(2025, 2, 27, 15, 30, 0); // 2025-03-27T15:30Z

function expectParsed(parsed: ReturnType<typeof parseUsageRangeArg>) {
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed;
}

describe("parseUsageRangeArg", () => {
  it("defaults to the last 30 days on empty args", () => {
    const parsed = parseUsageRangeArg("", NOW);
    expect(parsed).toEqual({
      range: { startDate: "2025-02-26", endDate: "2025-03-27" },
      label: "last 30 days",
    });
  });

  it("accepts a day count and clamps to at least 1 day", () => {
    expect(expectParsed(parseUsageRangeArg("7", NOW))).toEqual({
      range: { startDate: "2025-03-21", endDate: "2025-03-27" },
      label: "last 7 days",
    });

    expect(expectParsed(parseUsageRangeArg("1", NOW)).range).toEqual({
      startDate: "2025-03-27",
      endDate: "2025-03-27",
    });

    expect(expectParsed(parseUsageRangeArg("0", NOW)).range).toEqual({
      startDate: "2025-03-27",
      endDate: "2025-03-27",
    });
  });

  it("passes explicit public ids through in the range form", () => {
    for (const sep of ["to", "..", ",", "→"]) {
      const parsed = expectParsed(parseUsageRangeArg(`2025-03-01 ${sep} 2025-03-31`, NOW));
      expect(parsed.range).toEqual({ startDate: "2025-03-01", endDate: "2025-03-31" });
      expect(parsed.label).toBe("2025-03-01 → 2025-03-31");
    }
  });

  it("rejects an inverted range", () => {
    const parsed = parseUsageRangeArg("2025-03-31 to 2025-03-01", NOW);
    if (!("error" in parsed)) throw new Error("inverted range accepted");
    expect(parsed.error).toMatch(/after end date/);
  });

  it("rejects unparsable input with a helpful message", () => {
    const parsed = parseUsageRangeArg("last week", NOW);
    if (!("error" in parsed)) throw new Error("unparsable input accepted");
    expect(parsed.error).toMatch(/expected nothing|day count|range/);
  });
});

// --- actsis_litellm_usage tool ---

function makeToolContext() {
  return {
    sessionID: "session-1",
    messageID: "msg-1",
    agent: "agent-1",
    id: "call-1",
    signal: new AbortController().signal,
    progress: async () => {},
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface ActivityBody {
  results: Array<{
    date: string;
    metrics?: Record<string, unknown>;
    breakdown: { models: Record<string, unknown> };
  }>;
  metadata: Record<string, unknown>;
}

function aggregatedBody(): ActivityBody {
  return {
    results: [
      {
        date: "2025-03-26",
        metrics: { spend: 0.03, prompt_tokens: 250, completion_tokens: 450, total_tokens: 700, api_requests: 7 },
        breakdown: {
          models: {
            "openai/glm-x": {
              spend: 0.02,
              prompt_tokens: 150,
              completion_tokens: 350,
              total_tokens: 500,
              api_requests: 5,
            },
            "claude-z": {
              spend: 0.01,
              prompt_tokens: 100,
              completion_tokens: 100,
              total_tokens: 200,
              api_requests: 2,
            },
          },
        },
      },
    ],
    metadata: {
      total_spend: 0.03,
      total_prompt_tokens: 250,
      total_completion_tokens: 450,
      total_tokens: 700,
      total_api_requests: 7,
    },
  };
}

function gatewayResponseBody() {
  return {
    metadata: {
      total_successful_requests: 12,
      total_failed_requests: 2,
      total_requests: 14,
    },
  };
}

function stubUsageGateway(options?: { noGatewayEndpoint?: boolean; modelKeys?: string[] }) {
  const keys = options?.modelKeys ?? ["openai/glm-x", "claude-z"];
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/user/daily/activity/aggregated") {
      const body = aggregatedBody();
      const breakdownModels: Record<string, unknown> = body.results[0].breakdown.models;
      const rebuilt: Record<string, unknown> = {};
      for (const key of keys) rebuilt[key] = breakdownModels[key] ?? {
        spend: 0.01, prompt_tokens: 100, completion_tokens: 100, total_tokens: 200, api_requests: 2,
      };
      body.results[0].breakdown.models = rebuilt;
      return jsonResponse(body);
    }
    if (url.pathname === "/gateway/daily/activity" && !options?.noGatewayEndpoint) {
      return jsonResponse(gatewayResponseBody());
    }
    return jsonResponse("not found", 404);
  });
}

describe("actsis_litellm_usage", () => {
  let tmpDir: string;
  let authPath: string;
  const savedEnv: { stateDir?: string; dataHome?: string } = {};

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "actsis-litellm-usage-test-"));
    authPath = path.join(tmpDir, "auth.json");
    savedEnv.stateDir = process.env.ACTSIS_LITELLM_STATE_DIR;
    savedEnv.dataHome = process.env.XDG_DATA_HOME;
    process.env.ACTSIS_LITELLM_STATE_DIR = tmpDir;
    process.env.XDG_DATA_HOME = tmpDir;
    await writeFile(
      path.join(tmpDir, "state.json"),
      JSON.stringify({ version: 1, gatewayUrl: "https://gw.example.com" }),
    );
    await writeFile(
      authPath,
      JSON.stringify({ "actsis-litellm": { type: "api", key: "sk-test" } }),
    );
    await writeFile(
      path.join(tmpDir, "models-cache.json"),
      JSON.stringify({
        version: 2,
        fetchedAt: Date.now(),
        models: {
          "oc/glm-x": {
            name: "oc/glm-x", tool_call: true, reasoning: true,
            limit: { context: 128000, output: 16384 },
            modalities: { input: ["text"], output: ["text"] },
          },
          "claude-z": {
            name: "claude-z", tool_call: true, reasoning: true,
            limit: { context: 200000, output: 32000 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      }),
    );
  });

  afterEach(async () => {
    if (savedEnv.stateDir !== undefined) process.env.ACTSIS_LITELLM_STATE_DIR = savedEnv.stateDir;
    else delete process.env.ACTSIS_LITELLM_STATE_DIR;
    if (savedEnv.dataHome !== undefined) process.env.XDG_DATA_HOME = savedEnv.dataHome;
    else delete process.env.XDG_DATA_HOME;
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeDeps(
    fetchImpl?: typeof fetch,
    extra?: Partial<ToolDeps>,
  ): ToolDeps {
    return {
      providerId: "actsis-litellm",
      stateDir: tmpDir,
      authPath,
      fetchImpl,
      ...extra,
    };
  }

  function usageExecute(deps: ToolDeps) {
    const info = buildLitellmToolInfos(deps).find((t) => t.name === "actsis_litellm_usage")!;
    return (input: Record<string, unknown>) =>
      info.execute(input, makeToolContext()) as Promise<{ content: string }>;
  }

  it("exposes actsis_litellm_usage with an optional args input", () => {
    const infos = buildLitellmToolInfos({ providerId: "actsis-litellm" });
    const usage = infos.find((t) => t.name === "actsis_litellm_usage");
    expect(usage).toBeDefined();
    expect(usage!.input).toMatchObject({ type: "object" });
    const usageInput = usage!.input as { properties: Record<string, unknown> };
    expect(usageInput.properties.args).toBeDefined();
    expect(typeof usage!.execute).toBe("function");
  });

  it("renders the table with aliases, Total row, and gateway note by default", async () => {
    const fetchImpl = stubUsageGateway();
    const result = await usageExecute(makeDeps(fetchImpl as unknown as typeof fetch))({});

    expect(result.content).toContain("Usage (last 30 days):");
    // Internal deployment name aliased to the public catalog id.
    expect(result.content).toContain("oc/glm-x");
    expect(result.content).not.toContain("openai/glm-x");
    expect(result.content).toContain("$0.0200");
    expect(result.content).toContain("$0.0100");
    // Total row.
    expect(result.content).toMatch(/Total\s+\$0\.0300/);
    // Gateway activity footnote.
    expect(result.content).toContain("Gateway requests: 14 (successful 12 · failed 2) — includes non-logged traffic");

    // Aggregated endpoint was queried with the credential's own user id,
    // falling back to the v1 credential (no metadata): no user_id filter.
    const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls;
    const activityUrl = new URL(String(calls[0][0]));
    expect(activityUrl.pathname).toBe("/user/daily/activity/aggregated");
    const defaultRange = expectParsed(parseUsageRangeArg(""));
    expect(defaultRange.range.startDate).toBe(activityUrl.searchParams.get("start_date"));
    expect(defaultRange.range.endDate).toBe(activityUrl.searchParams.get("end_date"));
  });

  it("passes an explicit N-day window through to the usage query", async () => {
    const fetchImpl = stubUsageGateway();
    const result = await usageExecute(makeDeps(fetchImpl as unknown as typeof fetch))({ args: "7" });

    expect(result.content).toContain(`Usage (last 7 days):`);
    const expected = expectParsed(parseUsageRangeArg("7"));
    const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls;
    const activityUrl = new URL(String(calls[0][0]));
    expect(activityUrl.searchParams.get("start_date")).toBe(expected.range.startDate);
    expect(activityUrl.searchParams.get("end_date")).toBe(expected.range.endDate);
  });

  it("passes an explicit date range window through to the usage query", async () => {
    const fetchImpl = stubUsageGateway();
    await usageExecute(makeDeps(fetchImpl as unknown as typeof fetch))({
      args: "2025-03-01 .. 2025-03-31",
    });

    const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls;
    const activityUrl = new URL(String(calls[0][0]));
    expect(activityUrl.searchParams.get("start_date")).toBe("2025-03-01");
    expect(activityUrl.searchParams.get("end_date")).toBe("2025-03-31");
  });

  it("returns a helpful error for unparsable window input", async () => {
    const fetchImpl = stubUsageGateway();
    const result = await usageExecute(makeDeps(fetchImpl as unknown as typeof fetch))({
      args: "last week",
    });
    expect(result.content).toMatch(/Invalid window.*expected nothing|day count|range/s);
    // No gateway request was made.
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("returns a not-signed-in answer when no credential is stored", async () => {
    await rm(authPath, { force: true });
    const fetchImpl = stubUsageGateway();
    const result = await usageExecute(makeDeps(fetchImpl as unknown as typeof fetch))({});
    expect(result.content).toContain("Not signed in");
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("maps credential metadata userId into the usage query", async () => {
    const fetchImpl = stubUsageGateway();
    const result = await usageExecute(
      makeDeps(fetchImpl as unknown as typeof fetch, {
        getCredential: async () => ({
          type: "key",
          key: "sk-test",
          metadata: { userId: "user-42" },
        }),
      }),
    )({});

    expect(result.content).toMatch(/Total\s+\$0\.0300/);
    const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls;
    const gatewayUrls = calls.map((c) => new URL(String(c[0])));
    for (const url of gatewayUrls) {
      expect(url.searchParams.get("user_id")).toBe("user-42");
    }
  });

  it("answers with a clear error when the usage request fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const result = await usageExecute(makeDeps(fetchImpl as unknown as typeof fetch))({});
    expect(result.content).toContain("Usage unavailable:");
    expect(result.content).toContain("network down");
  });

  it("answers with the credential-rejected message on 401", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse("unauthorized", 401));
    const result = await usageExecute(makeDeps(fetchImpl as unknown as typeof fetch))({});
    expect(result.content).toContain("Credential rejected by gateway");
  });

  it("answers with a clear error when no usage endpoint is available", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse("not found", 404));
    const result = await usageExecute(makeDeps(fetchImpl as unknown as typeof fetch))({});
    expect(result.content).toContain("Usage unavailable:");
    expect(result.content).toContain("no usage endpoint available");
  });

  it("keeps the table when only the gateway footnote request fails", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/user/daily/activity/aggregated") {
        return jsonResponse(aggregatedBody());
      }
      throw new Error("gateway endpoint down");
    });
    const result = await usageExecute(makeDeps(fetchImpl as unknown as typeof fetch))({});
    expect(result.content).toMatch(/Total\s+\$0\.0300/);
    expect(result.content).not.toContain("Gateway requests:");
  });

  it("omits the gateway footnote when the proxy lacks the endpoint", async () => {
    const fetchImpl = stubUsageGateway({ noGatewayEndpoint: true });
    const result = await usageExecute(makeDeps(fetchImpl as unknown as typeof fetch))({});
    expect(result.content).toMatch(/Total\s+\$0\.0300/);
    expect(result.content).not.toContain("Gateway requests:");
  });
});
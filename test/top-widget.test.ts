import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelUsageSummary } from "../src/usage.ts";
import {
  buildTopModelsWidgetLines,
  computeTopModelRows,
  nbspRuns,
  readTopWidgetData,
  topWidgetLines,
  usageGauge,
  type TopWidgetData,
} from "../src/top-widget.ts";
import {
  defaultPreferences,
  readPreferences,
  readTopModelsWidgetEnabled,
  updateTopModelsWidgetEnabled,
} from "../src/preferences.ts";
import { parseTopPrefArg } from "../src/top-command.ts";
import { buildLitellmToolInfos, type ToolDeps } from "../src/tools.ts";
import { writePluginState, readPluginState } from "../src/state.ts";
import { runBudgetRefresh } from "../src/plugin.ts";

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makePrefsDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "top-widget-"));
  tempDirs.push(dir);
  return dir;
}

// --- Top-5 widget lines ---

const sampleRows = [
  { model: "oc/glm-5.3-flash", spend: 67.53 },
  { model: "oc/glm-5.3", spend: 30.94 },
  { model: "oc/deepseek-v4.1-flash", spend: 11.62 },
];

describe("usageGauge", () => {
  it("renders an 8-cell bar over [0,100]", () => {
    expect(usageGauge(0)).toBe("▱▱▱▱▱▱▱▱");
    expect(usageGauge(100)).toBe("▰▰▰▰▰▰▰▰");
    expect(usageGauge(50)).toBe("▰▰▰▰▱▱▱▱");
    expect(usageGauge(3)).toBe("▱▱▱▱▱▱▱▱");
    expect(usageGauge(90)).toBe("▰▰▰▰▰▰▰▱");
  });

  it("clamps out-of-range percentages", () => {
    expect(usageGauge(-5)).toBe("▱▱▱▱▱▱▱▱");
    expect(usageGauge(150)).toBe("▰▰▰▰▰▰▰▰");
  });
});

describe("buildTopModelsWidgetLines", () => {
  it("produces a title, an = separator, and one aligned row per model", () => {
    const lines = buildTopModelsWidgetLines({
      windowLabel: "7d",
      rows: sampleRows,
      totalSpend: 113.03,
    });
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("Top models (7d, UTC days)");
    expect(lines[0]).toContain("$113.03");
    expect(lines[1]).toMatch(/^=+$/);
    const width = lines[1].length;
    for (const row of lines.slice(2)) {
      expect(row).toHaveLength(width);
    }
    // Right-aligned share percentages before the gauge.
    expect(lines[2]).toMatch(/60%\s?/);
    // Gauge is the last element of each row.
    for (const row of lines.slice(2)) {
      expect(row.endsWith("▰") || row.endsWith("▱")).toBe(true);
    }
  });

  it("sorts by share: the biggest spend gets the fullest gauge", () => {
    const lines = buildTopModelsWidgetLines({
      windowLabel: "7d",
      rows: sampleRows,
      totalSpend: 113.03,
    });
    const filled = (line: string) => (line.match(/▰/g) ?? []).length;
    expect(filled(lines[2])).toBeGreaterThan(filled(lines[3]));
    expect(filled(lines[3])).toBeGreaterThan(filled(lines[4]));
  });

  it("computes share relative to the window total, capped at 100%", () => {
    const lines = buildTopModelsWidgetLines({
      windowLabel: "7d",
      rows: [{ model: "a", spend: 10 }, { model: "b", spend: 5 }],
      totalSpend: 7.5,
    });
    // a: 133% -> capped gauge full; the pct cell is clamped to 100.
    expect(lines[2]).toContain("100%");
    expect(lines[3]).toContain("67%");
  });

  it("omits the total from the title when not provided", () => {
    const lines = buildTopModelsWidgetLines({
      windowLabel: "7d",
      rows: sampleRows,
    });
    expect(lines[0]).toBe("Top models (7d, UTC days)");
  });

  it("renders at most 5 rows by default", () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      model: `model-${i}`,
      spend: 1 + i,
    }));
    const lines = buildTopModelsWidgetLines({ windowLabel: "7d", rows });
    expect(lines).toHaveLength(1 + 1 + 5);
  });

  it("truncates long model names to 26 chars with an ellipsis", () => {
    const long = "very-long-model-name/sixteenchars";
    const lines = buildTopModelsWidgetLines({
      windowLabel: "7d",
      rows: [{ model: long, spend: 1 }],
    });
    const asciiRow = lines[2].replace(/\u00a0/g, " ");
    expect(asciiRow.startsWith(`${long.slice(0, 25)}…`)).toBe(true);
  });

  it("pads columns with NBSP so alignment survives space-collapsing sanitizers", () => {
    const lines = buildTopModelsWidgetLines({
      windowLabel: "7d",
      rows: sampleRows,
      totalSpend: 113.03,
    });
    for (const row of lines.slice(2)) {
      expect(row).toContain("\u00a0");
      // No ASCII multi-space runs remain (they get collapsed by sanitizers).
      expect(row.replace(/\u00a0/g, "~")).not.toMatch(/\S {2,}\S/);
    }
    // All rendered lines have equal width in cells (NBSP counts as a cell).
    expect(new Set(lines.slice(2).map((row) => row.length))).toBeInstanceOf(Set);
    const widths = lines.slice(2).map((row) => row.length);
    expect(new Set(widths).size).toBe(1);
  });

  it("nbspRuns only converts runs of 2+ ASCII spaces", () => {
    expect(nbspRuns("a b   c")).toBe("a b\u00a0\u00a0\u00a0c");
    expect(nbspRuns("a b")).toBe("a b");
  });
});

// --- Top widget data (persisted state) ---

describe("topWidgetLines / readTopWidgetData", () => {
  const data: TopWidgetData = {
    rows: sampleRows,
    windowLabel: "7d",
    totalSpend: 113.03,
    refreshedAt: 1_000_000,
  };

  it("renders nothing when there are no rows", () => {
    expect(topWidgetLines({ ...data, rows: [] }, 2_000_000)).toBeNull();
    expect(topWidgetLines({ ...data, refreshedAt: Number.NaN }, 2_000_000)).toBeNull();
  });

  it("renders nothing (null) when the data is older than maxAgeSeconds", () => {
    expect(topWidgetLines(data, 1_000_000 + 301_000, 300)).toBeNull();
    expect(topWidgetLines(data, 1_000_000 + 299_000, 300)).not.toBeNull();
  });

  it("renders rows with the budget-free top block only", () => {
    const lines = topWidgetLines(data, 1_000_100);
    expect(lines?.length).toBe(5);
    expect(lines?.[0]).toContain("Top models (7d, UTC days)");
  });

  it("readTopWidgetData parses the persisted top fields", async () => {
    const dir = await makePrefsDir();
    await mkdir(path.join(dir, "actsis-litellm"), { recursive: true });
    await writeFile(
      path.join(dir, "actsis-litellm", "state.json"),
      JSON.stringify({
        lastTopModels: sampleRows,
        topRefreshedAt: 1_000_000,
        topWindowLabel: "7d",
        topTotalSpend: 113.03,
      }),
    );
    expect(await readTopWidgetData(dir)).toEqual(data);
  });

  it("readTopWidgetData returns null for missing, malformed, or empty data", async () => {
    const dir = await makePrefsDir();
    expect(await readTopWidgetData(dir)).toBeNull();

    await mkdir(path.join(dir, "actsis-litellm"), { recursive: true });
    const stateFile = path.join(dir, "actsis-litellm", "state.json");
    await writeFile(stateFile, "{not json");
    expect(await readTopWidgetData(dir)).toBeNull();

    await writeFile(
      stateFile,
      JSON.stringify({ lastTopModels: [], topRefreshedAt: 1 }),
    );
    expect(await readTopWidgetData(dir)).toBeNull();
  });
});

// --- Top-5 preference file ---

describe("top models widget preference persistence", () => {
  it("defaults to enabled when the file is missing", async () => {
    const dir = await makePrefsDir();
    expect(await readTopModelsWidgetEnabled(dir)).toBe(true);
  });

  it("round-trips disable/enable", async () => {
    const dir = await makePrefsDir();
    await updateTopModelsWidgetEnabled(false, dir);
    expect(await readTopModelsWidgetEnabled(dir)).toBe(false);
    await updateTopModelsWidgetEnabled(true, dir);
    expect(await readTopModelsWidgetEnabled(dir)).toBe(true);
  });

  it("defaults to enabled on a corrupt prefs file", async () => {
    const dir = await makePrefsDir();
    await writeFile(path.join(dir, "preferences.json"), "not json{");
    expect(await readTopModelsWidgetEnabled(dir)).toBe(true);
    // Writing again overwrites the corrupt content.
    await updateTopModelsWidgetEnabled(false, dir);
    expect(await readTopModelsWidgetEnabled(dir)).toBe(false);
  });

  it("writes atomically: no .tmp files are left behind", async () => {
    const dir = await makePrefsDir();
    await updateTopModelsWidgetEnabled(false, dir);
    const entries = await readdir(dir);
    expect(entries.filter((e) => e.includes(".tmp."))).toHaveLength(0);
    expect(entries).toContain("preferences.json");
  });

  it("defaultPreferences has the shared shape", () => {
    expect(defaultPreferences()).toEqual({ version: 1, topModelsWidget: true });
  });
});

// --- Toggle semantics ---

describe("parseTopPrefArg", () => {
  it("toggles on empty args", () => {
    expect(parseTopPrefArg("", true)).toEqual({ state: "off", changed: true });
    expect(parseTopPrefArg("", false)).toEqual({ state: "on", changed: true });
  });

  it("accepts explicit on/off and reports unchanged as already", () => {
    expect(parseTopPrefArg("on", false)).toEqual({ state: "on", changed: true });
    expect(parseTopPrefArg("on", true)).toEqual({ state: "on", changed: false });
    expect(parseTopPrefArg("off", true)).toEqual({ state: "off", changed: true });
  });

  it("rejects unknown args", () => {
    const parsed = parseTopPrefArg("maybe", true);
    expect("error" in parsed).toBe(true);
  });
});

// --- actsis_litellm_top tool ---

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

function aggregatedBodyWith(keys: Array<[string, number]>) {
  const models: Record<string, unknown> = {};
  for (const [key, spend] of keys) {
    models[key] = {
      spend,
      prompt_tokens: 100,
      completion_tokens: 100,
      total_tokens: 200,
      api_requests: 2,
    };
  }
  return {
    results: [
      {
        date: "2025-03-26",
        metrics: {
          spend: keys.reduce((s, [, v]) => s + v, 0),
          prompt_tokens: 100 * keys.length,
          completion_tokens: 100 * keys.length,
          total_tokens: 200 * keys.length,
          api_requests: 2 * keys.length,
        },
        breakdown: { models },
      },
    ],
    metadata: {
      total_spend: keys.reduce((s, [, v]) => s + v, 0),
      total_api_requests: 2 * keys.length,
    },
  };
}

describe("actsis_litellm_top tool", () => {
  let tmpDir: string;
  let authPath: string;
  const savedEnv: { stateDir?: string; dataHome?: string } = {};
  const savedCwd = process.cwd();

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "actsis-litellm-top-test-"));
    tempDirs.push(tmpDir);
    authPath = path.join(tmpDir, "auth.json");
    savedEnv.stateDir = process.env.ACTSIS_LITELLM_STATE_DIR;
    savedEnv.dataHome = process.env.XDG_DATA_HOME;
    process.env.ACTSIS_LITELLM_STATE_DIR = tmpDir;
    process.env.XDG_DATA_HOME = tmpDir;
    process.chdir(path.dirname(tmpDir));
    await writeFile(
      path.join(tmpDir, "state.json"),
      JSON.stringify({ version: 1, gatewayUrl: "https://gw.example.com" }),
    );
    await writeFile(
      authPath,
      JSON.stringify({ "actsis-litellm": { type: "api", key: "sk-test" } }),
    );
  });

  afterEach(async () => {
    if (savedEnv.stateDir !== undefined) process.env.ACTSIS_LITELLM_STATE_DIR = savedEnv.stateDir;
    else delete process.env.ACTSIS_LITELLM_STATE_DIR;
    if (savedEnv.dataHome !== undefined) process.env.XDG_DATA_HOME = savedEnv.dataHome;
    else delete process.env.XDG_DATA_HOME;
    vi.unstubAllGlobals();
    process.chdir(savedCwd);
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

  function topTool(fetchImpl?: typeof fetch, extra?: Partial<ToolDeps>) {
    const info = buildLitellmToolInfos(makeDeps(fetchImpl, extra))
      .find((t) => t.name === "actsis_litellm_top")!;
    return async (args?: string) =>
      (await info.execute({ ...(args !== undefined ? { args } : {}) }, makeToolContext())).content;
  }

  it("exposes actsis_litellm_top with an optional args input", () => {
    const infos = buildLitellmToolInfos(makeDeps());
    const top = infos.find((t) => t.name === "actsis_litellm_top")!;
    expect(top).toBeDefined();
    expect((top.input.properties as Record<string, unknown>).args).toBeDefined();
  });

  it("off disables the preference, clears rows, and skips the gateway fetch", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse("unused"));
    vi.stubGlobal("fetch", fetchSpy);
    // Seed persisted rows so we can see them cleared.
    await writePluginState(
      {
        version: 1,
        gatewayUrl: "https://gw.example.com",
        lastTopModels: sampleRows,
        topRefreshedAt: Date.now(),
        topWindowLabel: "7d",
        topTotalSpend: 113.03,
      },
      tmpDir,
    );
    await updateTopModelsWidgetEnabled(true, tmpDir);

    const top = topTool();
    const answer = await top("off");

    expect(answer).toMatch(/off/);
    expect(await readTopModelsWidgetEnabled(tmpDir)).toBe(false);
    const state = await readPluginState(tmpDir);
    expect(state?.lastTopModels).toEqual([]);
    expect(state?.topRefreshedAt).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("on enables the preference and fetches rows right away", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/user/daily/activity/aggregated") {
        return jsonResponse(aggregatedBodyWith([["oc/glm-x", 0.5], ["openai/glm-y", 0.3]]));
      }
      return jsonResponse("not found", 404);
    }));
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
          "oc/glm-y": {
            name: "oc/glm-y", tool_call: true, reasoning: true,
            limit: { context: 128000, output: 16384 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      }),
    );
    await updateTopModelsWidgetEnabled(false, tmpDir);

    const top = topTool();
    const answer = await top("on");

    expect(answer).toMatch(/on/);
    expect(await readTopModelsWidgetEnabled(tmpDir)).toBe(true);
    const state = await readPluginState(tmpDir);
    const rows = state?.lastTopModels ?? [];
    expect(rows.map((r) => r.model)).toEqual(["oc/glm-x", "oc/glm-y"]);
    expect(state?.topWindowLabel).toBe("7d");
    expect(state?.topRefreshedAt).toEqual(expect.any(Number));
  });

  it("empty args toggle the current state", async () => {
    const top = topTool();
    await updateTopModelsWidgetEnabled(true, tmpDir);
    await top();
    expect(await readTopModelsWidgetEnabled(tmpDir)).toBe(false);
    await top();
    expect(await readTopModelsWidgetEnabled(tmpDir)).toBe(true);
  });

  it("unknown args are rejected without touching state", async () => {
    const top = topTool();
    await updateTopModelsWidgetEnabled(true, tmpDir);
    const answer = await top("maybe");
    expect(answer).toMatch(/on|off|toggle/);
    expect(await readTopModelsWidgetEnabled(tmpDir)).toBe(true);
  });
});

// --- Server-side refresh shared with the budget trigger ---

function summaryWith(models: Array<[string, number]>): ModelUsageSummary {
  const entries = models.map(([model, spend]) => ({
    model,
    spend,
    promptTokens: 100,
    completionTokens: 100,
    totalTokens: 200,
    apiRequests: 2,
  }));
  const spend = entries.reduce((s, e) => s + e.spend, 0);
  return {
    startDate: "2025-03-20",
    endDate: "2025-03-26",
    totals: {
      spend,
      promptTokens: 100 * entries.length,
      completionTokens: 100 * entries.length,
      totalTokens: 200 * entries.length,
      apiRequests: 2 * entries.length,
    },
    models: entries,
  };
}

describe("runBudgetRefresh integration (top rows)", () => {
  let tmpDir: string;
  const savedEnv: { stateDir?: string; dataHome?: string } = {};

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "actsis-litellm-top-refresh-"));
    tempDirs.push(tmpDir);
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
  });

  function stubGateway(bodies: {
    budget?: unknown;
    aggregated?: unknown;
  }) {
    return vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/key/info") {
        return jsonResponse(bodies.budget ?? { spend: 7.89, max_budget: 100 });
      }
      if (url.pathname === "/user/daily/activity/aggregated") {
        return jsonResponse(bodies.aggregated ?? aggregatedBodyWith([["oc/glm-x", 0.5], ["openai/glm-y", 0.3]]));
      }
      return jsonResponse("not found", 404);
    });
  }

  async function seedCredential() {
    await writePluginState(
      { version: 1, gatewayUrl: "https://gw.example.com", providerId: "actsis-litellm" },
      tmpDir,
    );
    await mkdir(path.dirname(path.join(tmpDir, "auth.json")), { recursive: true });
    await writeFile(
      path.join(tmpDir, "auth.json"),
      JSON.stringify({ "actsis-litellm": { type: "api", key: "sk-test" } }),
    );
  }

  it("persisted snapshot includes top rows with public aliases", async () => {
    vi.stubGlobal("fetch", stubGateway({}));
    await seedCredential();
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
          "oc/glm-y": {
            name: "oc/glm-y", tool_call: true, reasoning: true,
            limit: { context: 128000, output: 16384 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      }),
    );

    await runBudgetRefresh(
      {
        baseUrl: "https://gw.example.com",
        providerId: "actsis-litellm",
        catalogTtlMs: 0,
        requestTimeoutMs: 30_000,
        authPath: path.join(tmpDir, "auth.json"),
        stateDir: tmpDir,
      },
      async () => null,
    );

    const state = await readPluginState(tmpDir);
    expect(state?.lastTopModels?.map((r) => r.model)).toEqual(["oc/glm-x", "oc/glm-y"]);
    expect(state?.topWindowLabel).toBe("7d");
    expect(state?.topTotalSpend).toBeCloseTo(0.8);
    expect(state?.topRefreshedAt).toEqual(expect.any(Number));
  });

  it("is silent and budget-only when the top fetch fails", async () => {
    const breaking = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/key/info") {
        return jsonResponse({ spend: 7.89, max_budget: 100 });
      }
      return jsonResponse("not found", 404);
    });
    vi.stubGlobal("fetch", breaking);
    await seedCredential();

    await expect(
      runBudgetRefresh(
        {
          baseUrl: "https://gw.example.com",
          providerId: "actsis-litellm",
          catalogTtlMs: 0,
          requestTimeoutMs: 30_000,
          authPath: path.join(tmpDir, "auth.json"),
          stateDir: tmpDir,
        },
        async () => null,
      ),
    ).resolves.toBeUndefined();

    const state = await readPluginState(tmpDir);
    expect(state?.lastBudgetSnapshot?.primary.spend).toBe(7.89);
    expect(state?.lastTopModels ?? []).toEqual([]);
  });

  it("honors the TTL: a second refresh inside the window skips the gateway", async () => {
    const fetchSpy = stubGateway({});
    vi.stubGlobal("fetch", fetchSpy);
    await seedCredential();
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
          "oc/glm-y": {
            name: "oc/glm-y", tool_call: true, reasoning: true,
            limit: { context: 128000, output: 16384 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      }),
    );

    const closure = {
      baseUrl: "https://gw.example.com",
      providerId: "actsis-litellm",
      catalogTtlMs: 0,
      requestTimeoutMs: 30_000,
      authPath: path.join(tmpDir, "auth.json"),
      stateDir: tmpDir,
    };
    await runBudgetRefresh(closure, async () => null);
    const usageCalls = fetchSpy.mock.calls.filter(([input]) =>
      String(input).includes("/user/daily/activity"),
    ).length;
    expect(usageCalls).toBeGreaterThan(0);

    await runBudgetRefresh(closure, async () => null);
    const usageCalls2 = fetchSpy.mock.calls.filter(([input]) =>
      String(input).includes("/user/daily/activity"),
    ).length;
    expect(usageCalls2).toBe(usageCalls); // TTL: no extra gateway queries
  });

  it("disabled preference: no gateway usage query and rows cleared", async () => {
    const fetchSpy = stubGateway({ budget: { spend: 7.89, max_budget: 100 } });
    vi.stubGlobal("fetch", fetchSpy);
    await seedCredential();
    await updateTopModelsWidgetEnabled(false, tmpDir);
    await writePluginState(
      {
        version: 1,
        gatewayUrl: "https://gw.example.com",
        lastTopModels: sampleRows,
        topRefreshedAt: Date.now(),
        topWindowLabel: "7d",
        topTotalSpend: 113.03,
      },
      tmpDir,
    );

    await runBudgetRefresh(
      {
        baseUrl: "https://gw.example.com",
        providerId: "actsis-litellm",
        catalogTtlMs: 0,
        requestTimeoutMs: 30_000,
        authPath: path.join(tmpDir, "auth.json"),
        stateDir: tmpDir,
      },
      async () => null,
    );

    const state = await readPluginState(tmpDir);
    expect(state?.lastTopModels).toEqual([]);
    const usageCalls = fetchSpy.mock.calls.filter(([input]) =>
      String(input).includes("/user/daily/activity"),
    ).length;
    expect(usageCalls).toBe(0);
    expect(state?.lastBudgetSnapshot?.primary.spend).toBe(7.89);
  });
});

// --- computeTopModelRows (alias + top-5 selection) ---

describe("computeTopModelRows", () => {
  it("slices to the top 5 spend rows and applies public aliases", () => {
    const summary = summaryWith([
      ["openai/glm-x", 3],
      ["claude-z", 2],
      ["other-1", 1],
      ["other-2", 1],
      ["other-3", 1],
      ["other-4", 1],
      ["other-5", 1],
      ["other-6", 0.5],
    ]);
    const { rows, totalSpend } = computeTopModelRows(summary, ["oc/glm-x"]);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({ model: "oc/glm-x", spend: 3 });
    expect(rows[1]).toEqual({ model: "claude-z", spend: 2 });
    expect(totalSpend).toBeCloseTo(10.5);
  });
});
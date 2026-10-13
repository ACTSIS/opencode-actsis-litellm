import { describe, expect, it, vi } from "vitest";
import {
  applyModelAliases,
  extractCredentialUserId,
  fetchGatewayRequests,
  fetchModelUsage,
  formatCompactTokens,
  formatUsageLines,
  formatUsageTable,
  isoDay,
  mapModelAliases,
  rangeLengthDays,
  resolveDefaultUsageRange,
  resolveUsageRangeDays,
  type ModelUsageSummary,
} from "../src/usage.ts";
import { AuthError, CatalogError } from "../src/errors.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface RecordedCall {
  url: URL;
  request: Request;
}

/**
 * Fake fetch in this repo's style (fetchImpl injection, see client.test.ts):
 * records every request and delegates to the scenario implementation.
 */
function makeFetch(
  impl: (call: RecordedCall) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const request = new Request(String(input), init);
    const call = { url, request };
    calls.push(call);
    return impl(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function dailyActivityBody() {
  return {
    results: [
      {
        date: "2025-03-26",
        metrics: {
          spend: 0.01,
          prompt_tokens: 100,
          completion_tokens: 200,
          total_tokens: 300,
          api_requests: 3,
        },
        breakdown: {
          models: {
            "gpt-x": {
              spend: 0.008,
              prompt_tokens: 60,
              completion_tokens: 150,
              total_tokens: 210,
              api_requests: 2,
            },
            "claude-y": {
              spend: 0.002,
              prompt_tokens: 40,
              completion_tokens: 50,
              total_tokens: 90,
              api_requests: 1,
            },
          },
        },
      },
      {
        date: "2025-03-27",
        metrics: {
          spend: 0.02,
          prompt_tokens: 150,
          completion_tokens: 250,
          total_tokens: 400,
          api_requests: 4,
        },
        breakdown: {
          models: {
            "gpt-x": {
              spend: 0.012,
              prompt_tokens: 70,
              completion_tokens: 180,
              total_tokens: 250,
              api_requests: 3,
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

const RANGE = { startDate: "2025-03-20", endDate: "2025-03-27" };

describe("resolveDefaultUsageRange", () => {
  it("returns the last 30 days inclusive of today", () => {
    const now = Date.UTC(2025, 2, 27, 15, 30, 0);
    const range = resolveDefaultUsageRange(now);
    expect(range.startDate).toBe("2025-02-26");
    expect(range.endDate).toBe("2025-03-27");
  });

  it("isoDay formats a UTC timestamp as YYYY-MM-DD", () => {
    expect(isoDay(Date.UTC(2025, 11, 5, 23, 59))).toBe("2025-12-05");
  });
});

describe("resolveUsageRangeDays", () => {
  it("returns the last N days inclusive of today", () => {
    const range = resolveUsageRangeDays(7, Date.UTC(2025, 2, 27, 15, 30, 0));
    expect(range).toEqual({ startDate: "2025-03-21", endDate: "2025-03-27" });
  });

  it("clamps to at least one day", () => {
    const range = resolveUsageRangeDays(0, Date.UTC(2025, 2, 27));
    expect(range.startDate).toBe("2025-03-27");
  });

  it("rangeLengthDays counts inclusive days", () => {
    expect(rangeLengthDays({ startDate: "2025-03-01", endDate: "2025-03-31" })).toBe(31);
    expect(rangeLengthDays({ startDate: "2025-03-27", endDate: "2025-03-27" })).toBe(1);
  });
});

describe("fetchModelUsage (aggregated endpoint)", () => {
  it("requests /user/daily/activity/aggregated with date params, user_id and bearer auth", async () => {
    const { fetchImpl, calls } = makeFetch((call) => {
      expect(call.url.pathname).toBe("/user/daily/activity/aggregated");
      expect(call.url.searchParams.get("start_date")).toBe("2025-03-20");
      expect(call.url.searchParams.get("end_date")).toBe("2025-03-27");
      return jsonResponse(dailyActivityBody());
    });
    const summary = await fetchModelUsage(
      "https://gw.example:4000/",
      "sk-test",
      5_000,
      RANGE,
      { userId: "u-1" },
      fetchImpl,
    );
    const auth = calls[0].request.headers.get("authorization");
    expect(auth).toBe("Bearer sk-test");
    expect(calls.length).toBe(1);
    expect(calls[0].url.searchParams.get("user_id")).toBe("u-1");
    expect(summary.startDate).toBe("2025-03-20");
    expect(summary.endDate).toBe("2025-03-27");
  });

  it("aggregates per-model metrics across days, sorted by spend desc, adopting query-scoped totals", async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse(dailyActivityBody()));
    const summary = await fetchModelUsage("https://gw.example", "sk-test", 5_000, RANGE, {}, fetchImpl);
    expect(summary.totals).toEqual({
      spend: 0.03,
      promptTokens: 250,
      completionTokens: 450,
      totalTokens: 700,
      apiRequests: 7,
    });
    expect(summary.models.map((m) => [m.model, m.spend, m.apiRequests])).toEqual([
      ["gpt-x", 0.02, 5],
      ["claude-y", 0.002, 1],
    ]);
    expect(summary.models[0]).toEqual({
      model: "gpt-x",
      spend: 0.02,
      promptTokens: 130,
      completionTokens: 330,
      totalTokens: 460,
      apiRequests: 5,
    });
  });

  it("sums rows per model when the aggregated rows nest metrics under breakdown", async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse({
        results: [
          {
            date: "2026-10-09",
            metrics: { spend: 1, total_tokens: 10, api_requests: 2 },
            breakdown: {
              models: {
                "openai/x": { metrics: { spend: 1, total_tokens: 10, api_requests: 2 } },
              },
            },
          },
          {
            date: "2026-10-08",
            metrics: { spend: 2, total_tokens: 20, api_requests: 3 },
            breakdown: {
              models: {
                "openai/x": { metrics: { spend: 2, total_tokens: 20, api_requests: 3 } },
              },
            },
          },
        ],
        metadata: { total_spend: 3, total_tokens: 30, total_api_requests: 5, total_pages: 1 },
      }),
    );
    const summary = await fetchModelUsage("https://gw.example", "sk-x", 5_000, RANGE, { userId: "u-1" }, fetchImpl);
    expect(summary.totals.spend).toBe(3);
    expect(summary.totals.totalTokens).toBe(30);
    expect(summary.totals.apiRequests).toBe(5);
    expect(summary.models[0]).toEqual({
      model: "openai/x",
      spend: 3,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 30,
      apiRequests: 5,
    });
  });

  it("derives totals from row sums when metadata is missing", async () => {
    const body = dailyActivityBody() as { results: unknown[]; metadata?: unknown };
    delete body.metadata;
    const { fetchImpl } = makeFetch(() => jsonResponse(body));
    const summary = await fetchModelUsage("https://gw.example", "sk-test", 5_000, RANGE, {}, fetchImpl);
    expect(summary.totals.spend).toBe(0.03);
    expect(summary.totals.apiRequests).toBe(7);
  });

  it("uses metadata totals when results are empty", async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse({
        results: [],
        metadata: {
          total_spend: 0.5,
          total_prompt_tokens: 100,
          total_completion_tokens: 200,
          total_tokens: 300,
          total_api_requests: 5,
        },
      }),
    );
    const summary = await fetchModelUsage("https://gw.example", "sk-x", 5_000, RANGE, {}, fetchImpl);
    expect(summary.totals).toEqual({
      spend: 0.5,
      promptTokens: 100,
      completionTokens: 200,
      totalTokens: 300,
      apiRequests: 5,
    });
  });

  it("falls back to row sums per missing metadata key", async () => {
    const body = dailyActivityBody() as { results: unknown[]; metadata: Record<string, number> };
    // Metadata carries only spend; the rest must fall back to row sums.
    body.metadata = { total_spend: 0.031 };
    const { fetchImpl } = makeFetch(() => jsonResponse(body));
    const summary = await fetchModelUsage("https://gw.example", "sk-test", 5_000, RANGE, {}, fetchImpl);
    expect(summary.totals.spend).toBe(0.031);
    expect(summary.totals.apiRequests).toBe(7);
    expect(summary.totals.totalTokens).toBe(700);
    expect(summary.totals.promptTokens).toBe(250);
    expect(summary.totals.completionTokens).toBe(450);
  });

  it("maps 401 to AuthError without retry", async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse({ detail: "Invalid API key" }, 401));
    await expect(
      fetchModelUsage("https://gw.example", "sk-bad", 5_000, RANGE, {}, fetchImpl),
    ).rejects.toThrow(AuthError);
    await expect(
      fetchModelUsage("https://gw.example", "sk-bad", 5_000, RANGE, {}, fetchImpl),
    ).rejects.toThrow(/Credential rejected by gateway/);
  });

  it("maps 403 to the permission-flavored AuthError", async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse({ detail: "no spend routes" }, 403));
    await expect(
      fetchModelUsage("https://gw.example", "sk-x", 5_000, RANGE, {}, fetchImpl),
    ).rejects.toThrow(/denied access to usage info \(403\)/);
  });

  it("maps invalid JSON to CatalogError", async () => {
    const fetchImpl = vi.fn(async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
    await expect(
      fetchModelUsage("https://gw.example", "sk-x", 5_000, RANGE, {}, fetchImpl),
    ).rejects.toThrow(CatalogError);
    await expect(
      fetchModelUsage("https://gw.example", "sk-x", 5_000, RANGE, {}, fetchImpl),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("maps empty results to zero totals and the no-usage message", async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse({ results: [], metadata: {} }));
    const summary = await fetchModelUsage("https://gw.example", "sk-x", 5_000, RANGE, {}, fetchImpl);
    expect(summary.totals.spend).toBe(0);
    expect(summary.models.length).toBe(0);
    const lines = formatUsageLines(summary);
    expect(lines[0]).toMatch(/spend \$0\.0000/);
    expect(lines[1]).toMatch(/no logged model usage/);
  });
});

describe("fetchModelUsage (pagination fallback)", () => {
  it("falls back to the paginated endpoint when aggregated is unavailable, summing rows across pages", async () => {
    const { fetchImpl, calls } = makeFetch((call) => {
      const path = call.url.pathname + call.url.search;
      if (path.includes("/aggregated")) {
        return jsonResponse({ detail: "not found" }, 404);
      }
      if (call.url.searchParams.get("page") === "2") {
        return jsonResponse({
          results: [
            {
              date: "2026-10-04",
              metrics: { spend: 1, total_tokens: 10, api_requests: 2 },
              breakdown: { models: { "m-b": { metrics: { spend: 1, total_tokens: 10, api_requests: 2 } } } },
            },
          ],
          // Page-scoped metadata: must NOT be adopted.
          metadata: { total_spend: 1, total_api_requests: 2 },
        });
      }
      return jsonResponse({
        results: [
          {
            date: "2026-10-05",
            metrics: { spend: 1, total_tokens: 10, api_requests: 1 },
            breakdown: { models: { "m-a": { spend: 1, total_tokens: 10, api_requests: 1 } } },
          },
        ],
        metadata: { total_spend: 1, total_api_requests: 1, has_more: true, total_pages: 2 },
      });
    });
    const summary = await fetchModelUsage("https://gw.example", "sk-x", 5_000, RANGE, { userId: "u-1" }, fetchImpl);
    expect(calls.filter((c) => c.url.pathname.startsWith("/user/daily/activity") && !c.url.pathname.includes("aggregated")).length).toBe(2);
    expect(calls.some((c) => c.url.searchParams.get("page") === "2")).toBe(true);
    expect(calls.some((c) => c.url.searchParams.get("page_size") === "200")).toBe(true);
    // Totals from summed rows (1+1), NOT from any single page's metadata.
    expect(summary.totals.spend).toBe(2);
    expect(summary.totals.apiRequests).toBe(3);
    expect(summary.models.map((m) => [m.model, m.spend])).toEqual([
      ["m-a", 1],
      ["m-b", 1],
    ]);
  });

  it("adopts per-page metadata only when the query fits one page", async () => {
    const { fetchImpl, calls } = makeFetch((call) => {
      if (call.url.pathname.includes("/aggregated")) {
        return jsonResponse({ detail: "not found" }, 404);
      }
      // One full page (has_more false, total_pages 1): metadata
      // totals are query-scoped and should be adopted even though
      // they disagree with the row sums.
      return jsonResponse({
        results: [
          {
            date: "2026-10-05",
            metrics: { spend: 1, total_tokens: 10, api_requests: 1 },
            breakdown: { models: { "m-a": { spend: 1, total_tokens: 10, api_requests: 1 } } },
          },
        ],
        metadata: { total_spend: 4.5, total_tokens: 90, total_api_requests: 12, has_more: false, total_pages: 1 },
      });
    });
    const summary = await fetchModelUsage("https://gw.example", "sk-x", 5_000, RANGE, { userId: "u-1" }, fetchImpl);
    expect(calls.length).toBe(2); // aggregated probe + one page
    expect(summary.totals.spend).toBe(4.5);
    expect(summary.totals.totalTokens).toBe(90);
    expect(summary.totals.apiRequests).toBe(12);
  });

  it("does not adopt page-scoped metadata when total_pages says more than one page", async () => {
    const { fetchImpl } = makeFetch((call) => {
      if (call.url.pathname.includes("/aggregated")) {
        return jsonResponse({ detail: "not found" }, 404);
      }
      return jsonResponse({
        results: [
          {
            date: "2026-10-05",
            metrics: { spend: 1, total_tokens: 10, api_requests: 1 },
            breakdown: { models: { "m-a": { spend: 1, total_tokens: 10, api_requests: 1 } } },
          },
        ],
        // has_more absent but total_pages > 1: page-scoped, must not be adopted.
        metadata: { total_spend: 99, total_api_requests: 99, total_pages: 3 },
      });
    });
    const summary = await fetchModelUsage("https://gw.example", "sk-x", 5_000, RANGE, { userId: "u-1" }, fetchImpl);
    expect(summary.totals.spend).toBe(1);
    expect(summary.totals.apiRequests).toBe(1);
  });

  it("throws when no usage endpoint is available", async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse({ detail: "not found" }, 404));
    await expect(
      fetchModelUsage("https://gw.example", "sk-x", 5_000, RANGE, {}, fetchImpl),
    ).rejects.toThrow(/no usage endpoint available/);
  });

  it("keeps walking pages up to the safety cap", async () => {
    let pageRequests = 0;
    const { fetchImpl } = makeFetch((call) => {
      if (call.url.pathname.includes("/aggregated")) {
        return jsonResponse({ detail: "not found" }, 404);
      }
      pageRequests += 1;
      if (pageRequests > 50) {
        throw new Error("too many pages requested");
      }
      return jsonResponse({
        results: [
          {
            date: "2026-10-05",
            metrics: { spend: 1, total_tokens: 10, api_requests: 1 },
            breakdown: { models: { "m-a": { spend: 1, total_tokens: 10, api_requests: 1 } } },
          },
        ],
        metadata: { has_more: true },
      });
    });
    const summary = await fetchModelUsage("https://gw.example", "sk-x", 5_000, RANGE, { userId: "u-1" }, fetchImpl);
    // 50 pages of 1 spend each; multi-page metadata was not adopted.
    expect(summary.totals.spend).toBe(50);
    expect(pageRequests).toBe(50); // walks exactly MAX_USAGE_PAGES pages
  });
});

describe("fetchGatewayRequests", () => {
  it("sums successful and failed gateway answers for the user", async () => {
    const { fetchImpl } = makeFetch((call) => {
      expect(call.url.pathname).toBe("/gateway/daily/activity");
      expect(call.url.searchParams.get("user_id")).toBe("u-1");
      return jsonResponse({
        metadata: { total_successful_requests: 86_272, total_failed_requests: 527 },
        results: [],
      });
    });
    const requests = await fetchGatewayRequests(
      "https://gw.example",
      "sk-x",
      5_000,
      RANGE,
      { userId: "u-1" },
      fetchImpl,
    );
    expect(requests).toEqual({ successful: 86_272, failed: 527, total: 86_799 });
  });

  it("reads totals at the top level when metadata omits them", async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse({ total_successful_requests: 100, total_failed_requests: 4, results: [] }),
    );
    const requests = await fetchGatewayRequests(
      "https://gw.example",
      "sk-x",
      5_000,
      RANGE,
      { userId: "u-1" },
      fetchImpl,
    );
    expect(requests).toEqual({ successful: 100, failed: 4, total: 104 });
  });

  it("returns null when the endpoint is unavailable (old proxies)", async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse({ detail: "nf" }, 404));
    const requests = await fetchGatewayRequests(
      "https://gw.example",
      "sk-x",
      5_000,
      RANGE,
      { userId: "u-1" },
      fetchImpl,
    );
    expect(requests).toBeNull();
  });
});

describe("mapModelAliases", () => {
  const publicIds = ["oc/glm-5.3-flash", "oc/glm-5.3", "oc/qwen3.6-35b"];

  it("passes through keys that already match a public id", () => {
    const aliases = mapModelAliases(["oc/glm-5.3-flash"], publicIds);
    expect(aliases.get("oc/glm-5.3-flash")).toBeUndefined();
  });

  it("maps an internal deployment name to the public alias via shared suffix", () => {
    const aliases = mapModelAliases(
      ["openai/glm-5.3-flash", "openai/deepseek-v4.1-flash"],
      publicIds,
    );
    expect(aliases.get("openai/glm-5.3-flash")).toBe("oc/glm-5.3-flash");
    expect(aliases.get("openai/deepseek-v4.1-flash")).toBeUndefined();
  });

  it("maps by exact id match when the suffix differs", () => {
    // An exact public id that is not a catalog suffix duplicate passes as-is;
    // a key identical to another catalog id never appears in the map.
    const aliases = mapModelAliases(["oc/glm-5.3"], publicIds);
    expect(aliases.get("oc/glm-5.3")).toBeUndefined();
  });

  it("is deterministic when two public ids share a suffix (sorted first wins)", () => {
    const aliases = mapModelAliases(
      ["openai/glm-5.3-flash"],
      ["oc/glm-5.3-flash", "team2/glm-5.3-flash"],
    );
    expect(aliases.get("openai/glm-5.3-flash")).toBe("oc/glm-5.3-flash");
  });

  it("leaves unknown keys alone (e.g. non-chat models filtered from catalog)", () => {
    const aliases = mapModelAliases(["openai/nomic-embed"], publicIds);
    expect(aliases.get("openai/nomic-embed")).toBeUndefined();
  });

  it("is case-insensitive on the suffix", () => {
    const aliases = mapModelAliases(["openai/GLM-5.3-Flash"], publicIds);
    expect(aliases.get("openai/GLM-5.3-Flash")).toBe("oc/glm-5.3-flash");
  });
});

describe("applyModelAliases", () => {
  const baseSummary = (): ModelUsageSummary => ({
    startDate: "2025-03-01",
    endDate: "2025-03-31",
    totals: {
      spend: 0.3,
      promptTokens: 100,
      completionTokens: 200,
      totalTokens: 300,
      apiRequests: 6,
    },
    models: [
      { model: "openai/glm-5.3-flash", spend: 0.2, promptTokens: 10, completionTokens: 20, totalTokens: 30, apiRequests: 2 },
      { model: "oc/glm-5.3-flash", spend: 0.1, promptTokens: 20, completionTokens: 40, totalTokens: 60, apiRequests: 1 },
      { model: "oc/qwen3.6-35b", spend: 0.1, promptTokens: 70, completionTokens: 140, totalTokens: 210, apiRequests: 3 },
    ],
  });

  it("merges entries aliasing to the same public id and re-sorts by spend", () => {
    const aliases = new Map([["openai/glm-5.3-flash", "oc/glm-5.3-flash"]]);
    const merged = applyModelAliases(baseSummary(), aliases);
    expect(merged.models.map((m) => [m.model, Math.round((m.spend ?? 0) * 1e6) / 1e6, m.apiRequests])).toEqual([
      ["oc/glm-5.3-flash", 0.3, 3],
      ["oc/qwen3.6-35b", 0.1, 3],
    ]);
    // Totals are unchanged by display-time merging.
    expect(merged.totals.spend).toBe(0.3);
    expect(merged.totals.apiRequests).toBe(6);
  });

  it("returns an equivalent summary when the alias map is empty", () => {
    const merged = applyModelAliases(baseSummary(), new Map());
    expect(merged.models).toEqual(baseSummary().models);
  });

  it("keeps totals independent from the input (no shared mutable state)", () => {
    const aliases = new Map([["openai/glm-5.3-flash", "oc/glm-5.3-flash"]]);
    const original = baseSummary();
    applyModelAliases(original, aliases);
    expect(original.models.length).toBe(3);
  });
});

describe("extractCredentialUserId", () => {
  it("reads userId from the v2 credential metadata", () => {
    expect(extractCredentialUserId({ metadata: { userId: "u-1234" } })).toBe("u-1234");
  });

  it("returns null for missing, empty or non-string metadata", () => {
    expect(extractCredentialUserId(null)).toBeNull();
    expect(extractCredentialUserId({})).toBeNull();
    expect(extractCredentialUserId({ metadata: {} })).toBeNull();
    expect(extractCredentialUserId({ metadata: { userId: "" } })).toBeNull();
    expect(extractCredentialUserId({ metadata: { userId: 42 } })).toBeNull();
  });
});

describe("formatCompactTokens", () => {
  it("uses B/M/k scales", () => {
    expect(formatCompactTokens(786_264_305)).toBe("786.3M");
    expect(formatCompactTokens(1_289_046)).toBe("1.29M");
    expect(formatCompactTokens(14_763)).toBe("14.8k");
    expect(formatCompactTokens(837)).toBe("837");
  });

  it("renders null as dash", () => {
    expect(formatCompactTokens(null)).toBe("-");
  });
});

describe("formatUsageLines", () => {
  it("formats totals and per-model rows", () => {
    const lines = formatUsageLines({
      startDate: "2025-03-20",
      endDate: "2025-03-27",
      totals: {
        spend: 0.03,
        promptTokens: 250,
        completionTokens: 450,
        totalTokens: 700,
        apiRequests: 7,
      },
      models: [
        {
          model: "gpt-x",
          spend: 0.02,
          promptTokens: 130,
          completionTokens: 330,
          totalTokens: 460,
          apiRequests: 5,
        },
      ],
    });
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatch(/Usage 2025-03-20 → 2025-03-27 \(8 days\): spend \$0\.0300/);
    expect(lines[1]).toMatch(/gpt-x\s+\$0\.0200\s+460 tok\s+5 reqs/);
  });
});

describe("formatUsageTable", () => {
  const summary = (): ModelUsageSummary => ({
    startDate: "2025-03-01",
    endDate: "2025-03-31",
    totals: {
      spend: 0.3,
      promptTokens: 100,
      completionTokens: 200,
      totalTokens: 300,
      apiRequests: 6,
    },
    models: [
      { model: "oc/glm-5.3-flash", spend: 0.2, promptTokens: 10, completionTokens: 20, totalTokens: 30, apiRequests: 2 },
      { model: "oc/qwen3.6-35b", spend: 0.1, promptTokens: 70, completionTokens: 140, totalTokens: 210, apiRequests: 3 },
    ],
  });

  it("renders an aligned table with header, rows and totals row", () => {
    const lines = formatUsageTable(summary());
    expect(lines[0]).toMatch(/^Usage 2025-03-01/);
    expect(lines[1]).toMatch(/^Model\b/);
    expect(lines[1]).toContain("Spend");
    expect(lines.some((l) => l.includes("---"))).toBe(true);
    expect(lines.at(-1)).toContain("Total");
    expect(lines.at(-1)).toContain("$0.3000");
    // Columns are aligned: right-aligned numeric columns end at the same index.
    const spendEnd = lines[1].indexOf("Spend") + "Spend".length;
    const rowEnd = lines[3].indexOf("$0.2000") + "$0.2000".length;
    expect(spendEnd).toBe(rowEnd);
  });

  it("truncates to topN when requested", () => {
    const many = summary();
    many.models = [
      ...many.models,
      ...Array.from({ length: 5 }, (_, i) => ({ model: `m${i}`, spend: 0.001 * (5 - i), promptTokens: 1, completionTokens: 1, totalTokens: 2, apiRequests: 1 })),
    ];
    const lines = formatUsageTable(many, { topN: 5 });
    expect(lines.at(-1)).toContain("Total");
    // Top 5 = 2 original rows + m0..m2 (m3/m4 are cut, counted in the note).
    expect(lines.some((l) => l.includes("m0"))).toBe(true);
    expect(lines.some((l) => l.includes("m2"))).toBe(true);
    expect(lines.some((l) => l.includes("m3"))).toBe(false);
    expect(lines.some((l) => l.includes("m4"))).toBe(false);
    expect(lines.some((l) => l.includes("(+2 more models)"))).toBe(true);
    expect(lines.indexOf("(+2 more models)")).toBeLessThan(lines.length - 1);
  });

  it("renders the no-usage message for empty models", () => {
    const empty = summary();
    empty.models = [];
    const lines = formatUsageTable(empty);
    expect(lines.at(-1)).toContain("no logged model usage");
  });
});
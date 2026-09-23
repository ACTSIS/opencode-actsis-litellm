import { describe, expect, it, vi } from "vitest";
import {
  mapCatalogModels,
  fetchCatalogModels,
  isChatModelId,
  extractMode,
  buildInfoMap,
  infoToConfig,
} from "../src/catalog.ts";
import { CatalogError } from "../src/errors.ts";

describe("extractMode", () => {
  it("returns entry.mode when present", () => {
    expect(extractMode({ mode: "chat" })).toBe("chat");
  });

  it("falls back to litellm_params.mode", () => {
    expect(extractMode({ litellm_params: { mode: "completion" } })).toBe("completion");
  });

  it("falls back to metadata.mode", () => {
    expect(extractMode({ metadata: { mode: "embedding" } })).toBe("embedding");
  });

  it("prefers entry.mode over nested modes", () => {
    expect(
      extractMode({
        mode: "chat",
        litellm_params: { mode: "embedding" },
        metadata: { mode: "rerank" },
      }),
    ).toBe("chat");
  });

  it("returns undefined when no mode is present", () => {
    expect(extractMode({ id: "gpt-4" })).toBeUndefined();
  });
});

describe("isChatModelId", () => {
  it("returns true for chat/completion metadata modes", () => {
    expect(isChatModelId("anything", "chat")).toBe(true);
    expect(isChatModelId("anything", "completion")).toBe(true);
  });

  it("returns false for known non-chat metadata modes", () => {
    expect(isChatModelId("anything", "embedding")).toBe(false);
    expect(isChatModelId("anything", "audio_speech")).toBe(false);
    expect(isChatModelId("anything", "realtime")).toBe(false);
  });

  it("falls back to conservative id regex when metadata mode is unknown", () => {
    expect(isChatModelId("text-embedding-ada-002")).toBe(false);
    expect(isChatModelId("whisper-1")).toBe(false);
    expect(isChatModelId("tts-1")).toBe(false);
    expect(isChatModelId("dall-e-3")).toBe(false);
    expect(isChatModelId("rerank-english-v2.0")).toBe(false);
  });

  it("allows legitimate models that contain risky substrings only as words", () => {
    // Bare 'audio'/'speech' are not rejected; see reference comments.
    expect(isChatModelId("gpt-4o-audio-preview")).toBe(true);
    expect(isChatModelId("some-speech-model")).toBe(false);
    expect(isChatModelId("stable-diffusion-xl")).toBe(false);
  });

  it("treats empty or null metadata mode as unknown", () => {
    expect(isChatModelId("gpt-4", "")).toBe(true);
    expect(isChatModelId("gpt-4", null)).toBe(true);
  });
});

describe("buildInfoMap", () => {
  it("maps the v1 data envelope by model_name", () => {
    const map = buildInfoMap({
      data: [
        {
          model_name: "qwen3.6-35b",
          model_info: { id: "opaque-deployment-id", max_input_tokens: 262144 },
        },
      ],
    });
    expect(map.get("qwen3.6-35b")?.model_info?.max_input_tokens).toBe(262144);
  });

  it("maps ids to info objects, keeping first occurrence", () => {
    const map = buildInfoMap([
      { id: "a", input_cost_per_token: 1e-6 },
      { id: "a", input_cost_per_token: 2e-6 },
    ]);
    expect(map.get("a")?.input_cost_per_token).toBe(1e-6);
  });

  it("ignores entries without an id", () => {
    const map = buildInfoMap([{ input_cost_per_token: 1e-6 }]);
    expect(map.size).toBe(0);
  });
});

describe("infoToConfig", () => {
  it("maps costs per million and uses provided limits", () => {
    const config = infoToConfig("gpt-4", {
      input_cost_per_token: 5e-6,
      output_cost_per_token: 15e-6,
      cache_read_input_token_cost: 1e-6,
      cache_creation_input_token_cost: 2e-6,
      max_input_tokens: 8192,
      max_output_tokens: 2048,
    });
    expect(config).toEqual({
      name: "gpt-4",
      tool_call: true,
      reasoning: true,
      limit: { context: 8192, output: 2048 },
      modalities: { input: ["text"], output: ["text"] },
      cost: {
        input: 5,
        output: 15,
        cache_read: 1,
        cache_write: 2,
      },
    });
  });

  it("applies default limits 128000/16384 when info lacks limits", () => {
    const config = infoToConfig("default-model", {});
    expect(config.limit).toEqual({ context: 128_000, output: 16_384 });
    expect(config.cost).toEqual({
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
    });
  });

  it("treats non-finite costs as 0", () => {
    const config = infoToConfig("bad-cost", {
      input_cost_per_token: Number.POSITIVE_INFINITY,
      output_cost_per_token: Number.NaN,
    });
    expect(config.cost).toEqual({ input: 0, output: 0, cache_read: 0, cache_write: 0 });
  });

  it("builds cost tiers above 128k/200k/272k/512k with shared cache rates", () => {
    const config = infoToConfig("tiered-model", {
      input_cost_per_token: 3e-6,
      output_cost_per_token: 15e-6,
      cache_read_input_token_cost: 0.5e-6,
      cache_creation_input_token_cost: 1e-6,
      input_cost_per_token_above_128k_tokens: 6e-6,
      output_cost_per_token_above_128k_tokens: 30e-6,
      input_cost_per_token_above_200k_tokens: 9e-6,
      output_cost_per_token_above_200k_tokens: 45e-6,
      input_cost_per_token_above_272k_tokens: 12e-6,
      output_cost_per_token_above_272k_tokens: 60e-6,
      input_cost_per_token_above_512k_tokens: 18e-6,
      output_cost_per_token_above_512k_tokens: 90e-6,
    });
    expect(config.cost?.tiers).toEqual([
      {
        input: 6,
        output: 30,
        cache: { read: 0.5, write: 1 },
        tier: { type: "context", size: 128_000 },
      },
      {
        input: 9,
        output: 45,
        cache: { read: 0.5, write: 1 },
        tier: { type: "context", size: 200_000 },
      },
      {
        input: 12,
        output: 60,
        cache: { read: 0.5, write: 1 },
        tier: { type: "context", size: 272_000 },
      },
      {
        input: 18,
        output: 90,
        cache: { read: 0.5, write: 1 },
        tier: { type: "context", size: 512_000 },
      },
    ]);
  });

  it("omits the tiers key when no tier fields are present", () => {
    const config = infoToConfig("plain-model", {
      input_cost_per_token: 3e-6,
      output_cost_per_token: 15e-6,
    });
    expect(config.cost).not.toHaveProperty("tiers");
  });

  it("keeps a tier with only input defined, mapping output to 0", () => {
    const config = infoToConfig("input-only-tier", {
      input_cost_per_token_above_128k_tokens: 6e-6,
    });
    expect(config.cost?.tiers).toEqual([
      {
        input: 6,
        output: 0,
        cache: { read: 0, write: 0 },
        tier: { type: "context", size: 128_000 },
      },
    ]);
  });

  it("treats non-finite tier costs as absent", () => {
    const config = infoToConfig("bad-tier", {
      input_cost_per_token_above_128k_tokens: Number.NaN,
      output_cost_per_token_above_128k_tokens: Number.POSITIVE_INFINITY,
    });
    expect(config.cost).not.toHaveProperty("tiers");
  });
});

describe("mapCatalogModels", () => {
  it("throws when data array is missing", () => {
    expect(() => mapCatalogModels({})).toThrow(CatalogError);
    expect(() => mapCatalogModels({ other: "value" } as unknown as { data: [] })).toThrow(CatalogError);
  });

  it("returns an empty list when every model is filtered out", () => {
    const models = mapCatalogModels({
      data: [
        { id: "text-embedding-ada-002", mode: "embedding" },
        { id: "whisper-1" },
      ],
    });
    expect(models).toEqual([]);
  });

  it("keeps chat models with mode metadata and skips non-chat by regex", () => {
    const models = mapCatalogModels({
      data: [
        { id: "gpt-4", mode: "chat" },
        { id: "claude-3-opus", mode: "completion" },
        { id: "text-embedding-3-small", mode: "embedding" },
        { id: "embeddings-v3", mode: "unknown" },
      ],
    });
    expect(models.map((m) => m.name)).toEqual(["claude-3-opus", "gpt-4"]);
  });

  it("dedupes by id preserving first occurrence", () => {
    const models = mapCatalogModels({
      data: [
        { id: "gpt-4", mode: "chat" },
        { id: "gpt-4", mode: "completion" },
      ],
    });
    expect(models.map((m) => m.name)).toEqual(["gpt-4"]);
  });

  it("sorts results by id", () => {
    const models = mapCatalogModels({
      data: [
        { id: "zebra", mode: "chat" },
        { id: "alpha", mode: "chat" },
        { id: "m3", mode: "chat" },
      ],
    });
    expect(models.map((m) => m.name)).toEqual(["alpha", "m3", "zebra"]);
  });

  it("merges /model/info enrichment into matching models", () => {
    const models = mapCatalogModels(
      {
        data: [{ id: "gpt-4", mode: "chat" }],
      },
      [
        {
          id: "gpt-4",
          input_cost_per_token: 5e-6,
          output_cost_per_token: 15e-6,
          max_input_tokens: 8192,
          max_output_tokens: 2048,
        },
      ],
    );
    expect(models).toHaveLength(1);
    expect(models[0]).toEqual({
      name: "gpt-4",
      tool_call: true,
      reasoning: true,
      limit: { context: 8192, output: 2048 },
      modalities: { input: ["text"], output: ["text"] },
      cost: { input: 5, output: 15, cache_read: 0, cache_write: 0 },
    });
  });

  it("maps nested model_info limits, costs, vision, and reasoning capability", () => {
    const models = mapCatalogModels(
      { data: [{ id: "oc/kimi-k3" }] },
      {
        data: [
          {
            model_name: "oc/kimi-k3",
            model_info: {
              mode: "chat",
              max_input_tokens: 262144,
              max_output_tokens: 32768,
              input_cost_per_token: 4.16e-8,
              output_cost_per_token: 1.04e-6,
              supports_vision: true,
              reasoning_effort_levels: ["none", "minimal", "low", "medium", "high", "max"],
            },
          },
        ],
      },
    );

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      name: "oc/kimi-k3",
      reasoning: true,
      limit: { context: 262144, output: 32768 },
      modalities: { input: ["text", "image"], output: ["text"] },
      cost: { output: 1.04, cache_read: 0, cache_write: 0 },
      variants: {
        none: { reasoningEffort: "none" },
        minimal: { reasoningEffort: "minimal" },
        low: { reasoningEffort: "low" },
        medium: { reasoningEffort: "medium" },
        high: { reasoningEffort: "high" },
        max: { reasoningEffort: "max" },
      },
    });
    expect(models[0].cost?.input).toBeCloseTo(0.0416);
  });

  it("uses info entry mode metadata when /v1/models entry lacks mode", () => {
    const models = mapCatalogModels(
      {
        data: [{ id: "gpt-4" }],
      },
      [{ id: "gpt-4", mode: "chat", input_cost_per_token: 1e-6 }],
    );
    expect(models[0].name).toBe("gpt-4");
    expect(models[0].cost?.input).toBe(1);
  });

  it("applies default limits and costs when enrichment is absent", () => {
    const models = mapCatalogModels({
      data: [{ id: "gpt-3.5", mode: "chat" }],
    });
    expect(models[0].limit).toEqual({ context: 128_000, output: 16_384 });
    expect(models[0].cost).toEqual({
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
    });
  });
});

describe("fetchCatalogModels", () => {
  it("calls /v1/models and /model/info and returns mapped models", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const urlString = url.toString();
      if (urlString.includes("/v1/models")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: "gpt-4", mode: "chat" },
              { id: "text-embedding-ada-002", mode: "embedding" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (urlString.includes("/model/info")) {
        return new Response(
          JSON.stringify([
            {
              id: "gpt-4",
              input_cost_per_token: 5e-6,
              output_cost_per_token: 15e-6,
              max_input_tokens: 8192,
              max_output_tokens: 2048,
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const models = await fetchCatalogModels(
      { baseUrl: "https://gw.example", requestTimeoutMs: 5000, catalogTtlMs: 0, providerId: "p" },
      "sk-test",
      undefined,
      fetchImpl,
    );

    expect(models.map((m) => m.name)).toEqual(["gpt-4"]);
    expect(models[0].cost).toEqual({ input: 5, output: 15, cache_read: 0, cache_write: 0 });
  });

  it("maps nested model_info costs with nested-wins semantics over the outer entry", () => {
    const models = mapCatalogModels(
      { data: [{ id: "oc/kimi-k3" }] },
      [
        {
          model_name: "oc/kimi-k3",
          input_cost_per_token: 1e-6,
          model_info: {
            input_cost_per_token: 4.16e-8,
            output_cost_per_token: 1.04e-6,
          },
        },
      ],
    );
    expect(models).toHaveLength(1);
    expect(models[0].cost?.input).toBeCloseTo(0.0416);
    expect(models[0].cost?.output).toBeCloseTo(1.04);
  });

  it("falls back to paginated /v2/model/info when /model/info fails", async () => {
    const requestedUrls: string[] = [];
    const tieredInfo = {
      model_name: "gpt-4",
      input_cost_per_token: 5e-6,
      output_cost_per_token: 15e-6,
      input_cost_per_token_above_128k_tokens: 6e-6,
      output_cost_per_token_above_128k_tokens: 30e-6,
      max_input_tokens: 8192,
      max_output_tokens: 2048,
    };
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const urlString = url.toString();
      requestedUrls.push(urlString);
      if (urlString.includes("/v1/models")) {
        return new Response(
          JSON.stringify({ data: [{ id: "gpt-4", mode: "chat" }] }),
          { status: 200 },
        );
      }
      if (urlString.includes("/v1/model/info")) {
        return new Response("error", { status: 500 });
      }
      const page = Number(new URL(urlString).searchParams.get("page"));
      if (page === 1) {
        return new Response(
          JSON.stringify({ data: [tieredInfo], total_pages: 3 }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          data: [
            {
              model_name: `other-model-${page}`,
              input_cost_per_token: page * 1e-6,
            },
          ],
        }),
        { status: 200 },
      );
    });

    const models = await fetchCatalogModels(
      { baseUrl: "https://gw.example", requestTimeoutMs: 5000, catalogTtlMs: 0, providerId: "p" },
      "sk-test",
      undefined,
      fetchImpl,
    );

    expect(requestedUrls.filter((u) => u.includes("/v2/model/info"))).toEqual([
      "https://gw.example/v2/model/info?size=100&page=1",
      "https://gw.example/v2/model/info?size=100&page=2",
      "https://gw.example/v2/model/info?size=100&page=3",
    ]);
    expect(models.map((m) => m.name)).toEqual(["gpt-4"]);
    expect(models[0].cost).toMatchObject({ input: 5, output: 15 });
    expect(models[0].cost?.tiers).toEqual([
      {
        input: 6,
        output: 30,
        cache: { read: 0, write: 0 },
        tier: { type: "context", size: 128_000 },
      },
    ]);
  });

  it("caps v2 pagination at 5 pages even with more total pages", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const urlString = url.toString();
      requestedUrls.push(urlString);
      if (urlString.includes("/v1/models")) {
        return new Response(
          JSON.stringify({ data: [{ id: "gpt-4", mode: "chat" }] }),
          { status: 200 },
        );
      }
      if (urlString.includes("/v1/model/info")) {
        return new Response("[]", { status: 200 });
      }
      const page = Number(new URL(urlString).searchParams.get("page"));
      return new Response(
        JSON.stringify({
          data: page === 1
            ? [{ model_name: "gpt-4", input_cost_per_token: 5e-6 }]
            : [],
          total_pages: 12,
        }),
        { status: 200 },
      );
    });

    const models = await fetchCatalogModels(
      { baseUrl: "https://gw.example", requestTimeoutMs: 5000, catalogTtlMs: 0, providerId: "p" },
      "sk-test",
      undefined,
      fetchImpl,
    );

    const v2Pages = requestedUrls
      .filter((u) => u.includes("/v2/model/info"))
      .map((u) => Number(new URL(u).searchParams.get("page")));
    expect(v2Pages).toEqual([1, 2, 3, 4, 5]);
    expect(models.map((m) => m.name)).toEqual(["gpt-4"]);
  });

  it("proceeds without enrichment when both /model/info and v2 fallback fail", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const urlString = url.toString();
      if (urlString.includes("/v1/models")) {
        return new Response(
          JSON.stringify({ data: [{ id: "gpt-4", mode: "chat" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("error", { status: 500 });
    });

    const models = await fetchCatalogModels(
      { baseUrl: "https://gw.example", requestTimeoutMs: 5000, catalogTtlMs: 0, providerId: "p" },
      "sk-test",
      undefined,
      fetchImpl,
    );

    expect(models.map((m) => m.name)).toEqual(["gpt-4"]);
    expect(models[0].cost?.input).toBe(0);
  });
});

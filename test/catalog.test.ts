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

  it("proceeds without enrichment when /model/info fails", async () => {
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

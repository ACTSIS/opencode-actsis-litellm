import { describe, it, expect } from "vitest";
import {
  normalizeBaseUrl,
  resolveConfig,
  type PluginOptions,
} from "../src/config.ts";

function makeDeps(opts: {
  env?: Record<string, string | undefined>;
  options?: PluginOptions | null;
  prompt?: () => Promise<string | null | undefined>;
  storedUrl?: string | null;
}) {
  return {
    env: opts.env ?? {},
    options: opts.options,
    prompt: opts.prompt ?? (async () => null),
    storedUrl: opts.storedUrl,
  };
}

describe("normalizeBaseUrl", () => {
  it("strips trailing slash", () => {
    expect(normalizeBaseUrl("https://gateway.example.com/")).toBe(
      "https://gateway.example.com",
    );
  });

  it("strips trailing /v1", () => {
    expect(normalizeBaseUrl("https://gateway.example.com/v1")).toBe(
      "https://gateway.example.com",
    );
  });

  it("strips trailing slash + /v1", () => {
    expect(normalizeBaseUrl("https://gateway.example.com/v1/")).toBe(
      "https://gateway.example.com",
    );
  });

  it("rejects non-http schemes", () => {
    expect(() => normalizeBaseUrl("ftp://gateway.example.com")).toThrow(
      "Only http:// and https:// are supported",
    );
  });

  it("rejects invalid URLs", () => {
    expect(() => normalizeBaseUrl("not a url")).toThrow("Invalid gateway URL");
  });
});

describe("resolveConfig", () => {
  it("uses env variable first", async () => {
    const deps = makeDeps({
      env: { ACTSIS_LITELLM_URL: "https://env.example.com/" },
      options: { url: "https://options.example.com" },
      storedUrl: "https://stored.example.com",
    });
    const config = await resolveConfig(deps);
    expect(config.baseUrl).toBe("https://env.example.com");
  });

  it("falls back to plugin options when env is absent", async () => {
    const deps = makeDeps({
      options: { url: "https://options.example.com" },
      storedUrl: "https://stored.example.com",
    });
    const config = await resolveConfig(deps);
    expect(config.baseUrl).toBe("https://options.example.com");
  });

  it("falls back to stored URL before prompting", async () => {
    const deps = makeDeps({
      storedUrl: "https://stored.example.com",
      prompt: async () => "https://prompt.example.com",
    });
    const config = await resolveConfig(deps);
    expect(config.baseUrl).toBe("https://stored.example.com");
  });

  it("prompts when nothing else is configured", async () => {
    const deps = makeDeps({
      prompt: async () => "https://prompt.example.com/",
    });
    const config = await resolveConfig(deps);
    expect(config.baseUrl).toBe("https://prompt.example.com");
  });

  it("applies plugin option TTL and timeout settings", async () => {
    const deps = makeDeps({
      env: { ACTSIS_LITELLM_URL: "https://env.example.com" },
      options: {
        catalogTtlMinutes: 5,
        requestTimeoutMs: 10_000,
        providerId: "custom-litellm",
      },
    });
    const config = await resolveConfig(deps);
    expect(config.catalogTtlMs).toBe(5 * 60 * 1000);
    expect(config.requestTimeoutMs).toBe(10_000);
    expect(config.providerId).toBe("custom-litellm");
  });

  it("uses defaults when settings are missing", async () => {
    const deps = makeDeps({
      env: { ACTSIS_LITELLM_URL: "https://env.example.com" },
    });
    const config = await resolveConfig(deps);
    expect(config.providerId).toBe("actsis-litellm");
    expect(config.catalogTtlMs).toBe(15 * 60 * 1000);
    expect(config.requestTimeoutMs).toBe(30_000);
  });

  it("throws ConfigError when everything is missing", async () => {
    const deps = makeDeps({});
    await expect(resolveConfig(deps)).rejects.toThrow(
      "Gateway base URL not configured",
    );
  });

  it("prefers env over options and stored", async () => {
    const deps = makeDeps({
      env: { ACTSIS_LITELLM_URL: "https://env.example.com" },
      options: { url: "https://options.example.com" },
      storedUrl: "https://stored.example.com",
    });
    const config = await resolveConfig(deps);
    expect(config.baseUrl).toBe("https://env.example.com");
  });
});

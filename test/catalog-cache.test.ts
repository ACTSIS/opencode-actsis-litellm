import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  loadCachedModels,
  saveCachedModels,
  computeCacheAge,
  type OpencodeModelConfig,
} from "../src/catalog-cache.ts";

describe("catalog cache", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "actsis-litellm-cache-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function sampleModel(id: string): OpencodeModelConfig {
    return {
      name: id,
      tool_call: true,
      reasoning: false,
      limit: { context: 128_000, output: 16_384 },
      modalities: { input: ["text"], output: ["text"] },
      cost: { input: 5, output: 15 },
    };
  }

  it("roundtrips models", async () => {
    const models: Record<string, OpencodeModelConfig> = {
      "gpt-4o": sampleModel("gpt-4o"),
      "claude-3-5-sonnet": sampleModel("claude-3-5-sonnet"),
    };

    await saveCachedModels(models, tmpDir);
    const loaded = await loadCachedModels(tmpDir);

    expect(loaded).toEqual(models);
  });

  it("rejects schema version mismatch", async () => {
    await writeFile(
      path.join(tmpDir, "models-cache.json"),
      JSON.stringify({
        version: 99,
        fetchedAt: Date.now(),
        models: { "gpt-4o": sampleModel("gpt-4o") },
      }),
    );

    const loaded = await loadCachedModels(tmpDir);
    expect(loaded).toBeNull();
  });

  it("computes cache age", async () => {
    const now = Date.now();
    vi.setSystemTime(now);

    await saveCachedModels({ "gpt-4o": sampleModel("gpt-4o") }, tmpDir);
    const age = await computeCacheAge(tmpDir);

    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(1000);

    vi.useRealTimers();
  });

  it("returns null for corrupt JSON", async () => {
    await writeFile(path.join(tmpDir, "models-cache.json"), "{not json");
    expect(await loadCachedModels(tmpDir)).toBeNull();
    expect(await computeCacheAge(tmpDir)).toBeNull();
  });

  it("returns null for missing models field", async () => {
    await writeFile(
      path.join(tmpDir, "models-cache.json"),
      JSON.stringify({ version: 1, fetchedAt: Date.now() }),
    );
    expect(await loadCachedModels(tmpDir)).toBeNull();
  });
});

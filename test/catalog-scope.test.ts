import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  catalogScopeHint,
  catalogScopeLine,
  loadCachedModels,
  loadCachedScope,
  saveCachedModels,
  type CachedCatalogScope,
  type OpencodeModelConfig,
} from "../src/catalog-cache.ts";

function modelConfig(name: string): OpencodeModelConfig {
  return {
    name,
    tool_call: true,
    reasoning: true,
    limit: { context: 128000, output: 16384 },
    modalities: { input: ["text"], output: ["text"] },
  } as OpencodeModelConfig;
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "actsis-cat-scope-"));
}

describe("catalog fetch scope (issue pi #48 S3)", () => {
  it("save/load roundtrip preserves the credential scope and the models", async () => {
    const dir = await tempDir();
    try {
      const scope: CachedCatalogScope = {
        kind: "oauth",
        userId: "2ed0da75-556d",
        teamId: "ad59169e-f0c9",
      };
      await saveCachedModels({ "oc/glm-5.2": modelConfig("oc/glm-5.2") }, dir, scope);

      expect(await loadCachedScope(dir)).toEqual(scope);
      expect(Object.keys((await loadCachedModels(dir)) ?? {})).toEqual(["oc/glm-5.2"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("tolerates a v2 cache written without scope metadata", async () => {
    const dir = await tempDir();
    try {
      await writeFile(
        path.join(dir, "models-cache.json"),
        JSON.stringify({ version: 2, fetchedAt: Date.now(), models: {} }),
        "utf8",
      );
      expect(await loadCachedScope(dir)).toBeNull();
      // The models still load (additive field, readers stay compatible).
      expect(await loadCachedModels(dir)).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores a malformed scope instead of failing the cache read", async () => {
    const dir = await tempDir();
    try {
      await writeFile(
        path.join(dir, "models-cache.json"),
        JSON.stringify({
          version: 2,
          fetchedAt: Date.now(),
          models: {},
          credential: { kind: "saml" },
        }),
        "utf8",
      );
      expect(await loadCachedScope(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("renders an OAuth session scope with its team", () => {
    const line = catalogScopeLine({
      kind: "oauth",
      userId: "2ed0da75-556d",
      teamId: "ad59169e-f0c9",
    });
    expect(line).toMatch(/OAuth session/);
    expect(line).toMatch(/team ad59169e-f0c9/);
  });

  it("renders an OAuth session scope without a team", () => {
    expect(catalogScopeLine({ kind: "oauth" })).toMatch(/OAuth session \(no team\)/);
  });

  it("renders API-key credentials", () => {
    expect(catalogScopeLine({ kind: "api_key" })).toMatch(/API key/);
  });

  it("renders unknown when the cache predates the scope metadata", () => {
    expect(catalogScopeLine(null)).toMatch(/unknown/i);
  });

  it("oc/*-only catalog with a team scope yields the re-login hint", () => {
    const hint = catalogScopeHint(
      ["oc/glm-5.2", "oc/gpt-oss:20b"],
      { kind: "oauth", userId: "u1", teamId: "t1" },
    );
    expect(hint ?? "").toMatch(/login again/i);
    expect(hint ?? "").toMatch(/team/);
  });

  it("mixed catalog with the same team scope yields no hint", () => {
    expect(
      catalogScopeHint(["oc/glm-5.2", "gpt-oss-120b"], {
        kind: "oauth",
        userId: "u1",
        teamId: "t1",
      }),
    ).toBeUndefined();
  });

  it("team-less scope never yields the hint", () => {
    expect(catalogScopeHint(["oc/glm-5.2"], { kind: "oauth" })).toBeUndefined();
    expect(catalogScopeHint(["oc/glm-5.2"], { kind: "api_key" })).toBeUndefined();
  });
});

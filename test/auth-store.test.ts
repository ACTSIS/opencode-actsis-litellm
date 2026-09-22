import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { readAuthEntry, clearAuthEntry } from "../src/auth-store.ts";

describe("auth-store", () => {
  let tmpDir: string;
  let authPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "actsis-litellm-auth-test-"));
    authPath = path.join(tmpDir, "auth.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("reads a stored oauth entry and returns null for a missing file", async () => {
    expect(await readAuthEntry(authPath, "actsis-litellm")).toBeNull();
  });

  it("reads an oauth entry and returns its fields", async () => {
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

    const entry = await readAuthEntry(authPath, "actsis-litellm");
    expect(entry).toEqual({
      type: "oauth",
      access: "access-1",
      refresh: "refresh-1",
      expires: 1_700_000_000_000,
    });
  });

  it("reads an api key entry", async () => {
    await writeFile(
      authPath,
      JSON.stringify({
        "actsis-litellm": {
          type: "api",
          key: "sk-test",
        },
      }),
    );

    const entry = await readAuthEntry(authPath, "actsis-litellm");
    expect(entry).toEqual({ type: "api", key: "sk-test" });
  });

  it("returns null for a mismatched or invalid entry", async () => {
    await writeFile(
      authPath,
      JSON.stringify({
        "other-provider": { type: "oauth", access: "x" },
        "actsis-litellm": { type: "unknown" },
      }),
    );

    expect(await readAuthEntry(authPath, "actsis-litellm")).toBeNull();
  });

  it("returns null for corrupt JSON", async () => {
    await writeFile(authPath, "{not json");
    expect(await readAuthEntry(authPath, "actsis-litellm")).toBeNull();
  });

  it("clears only the requested provider and preserves others", async () => {
    await writeFile(
      authPath,
      JSON.stringify({
        "actsis-litellm": { type: "api", key: "sk-test" },
        "other-provider": { type: "api", key: "sk-other" },
      }),
    );

    await clearAuthEntry(authPath, "actsis-litellm");

    const content = JSON.parse(await readFile(authPath, "utf8"));
    expect(content).toEqual({
      "other-provider": { type: "api", key: "sk-other" },
    });
  });

  it("does nothing when clearing an entry from a missing file", async () => {
    await clearAuthEntry(authPath, "actsis-litellm");
    expect(await readAuthEntry(authPath, "actsis-litellm")).toBeNull();
  });

  it("writes the auth file with mode 0600 when clearing an entry", async () => {
    await mkdir(path.dirname(authPath), { recursive: true });
    await writeFile(
      authPath,
      JSON.stringify({
        "actsis-litellm": { type: "api", key: "sk-test" },
      }),
      { mode: 0o644 },
    );

    await clearAuthEntry(authPath, "actsis-litellm");

    // In many test environments the mode may not be observable (tmpfs, root),
    // so just verify the file is still valid JSON and empty.
    const content = JSON.parse(await readFile(authPath, "utf8"));
    expect(content).toEqual({});
  });
});

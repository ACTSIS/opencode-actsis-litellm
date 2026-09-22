import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  readPluginState,
  writePluginState,
  updatePluginState,
  type PluginState,
} from "../src/state.ts";

describe("plugin state", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "actsis-litellm-state-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes and reads state", async () => {
    const state: PluginState = {
      version: 1,
      gatewayUrl: "https://gateway.example.com",
      authMode: "oauth",
      clientId: "client-1",
      savedAt: 1_700_000_000_000,
    };

    await writePluginState(state, tmpDir);
    const read = await readPluginState(tmpDir);
    expect(read).toEqual(state);
  });

  it("returns null for version mismatch", async () => {
    await writeFile(
      path.join(tmpDir, "state.json"),
      JSON.stringify({ version: 99, gatewayUrl: "https://example.com" }),
    );
    const read = await readPluginState(tmpDir);
    expect(read).toBeNull();
  });

  it("returns null for corrupt JSON", async () => {
    await writeFile(path.join(tmpDir, "state.json"), "{not json");
    const read = await readPluginState(tmpDir);
    expect(read).toBeNull();
  });

  it("update patches existing state", async () => {
    const first: PluginState = {
      version: 1,
      gatewayUrl: "https://gateway.example.com",
      authMode: "oauth",
    };
    await writePluginState(first, tmpDir);

    const next = await updatePluginState({ clientId: "client-2" }, tmpDir);

    expect(next.gatewayUrl).toBe("https://gateway.example.com");
    expect(next.authMode).toBe("oauth");
    expect(next.clientId).toBe("client-2");
    expect(next.savedAt).toBeGreaterThan(0);
  });
});

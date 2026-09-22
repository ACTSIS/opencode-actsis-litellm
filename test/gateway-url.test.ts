import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import {
  readStoredCredentialGatewayUrl,
  pickGatewayUrl,
  upgradeHttpToHttps,
} from "../src/gateway-url.ts";

describe("upgradeHttpToHttps", () => {
  it("upgrades http to https", () => {
    expect(upgradeHttpToHttps("http://gateway.example.com")).toBe(
      "https://gateway.example.com",
    );
  });

  it("leaves https unchanged", () => {
    expect(upgradeHttpToHttps("https://gateway.example.com")).toBe(
      "https://gateway.example.com",
    );
  });
});

describe("pickGatewayUrl", () => {
  it("prefers env over options and stored", () => {
    const result = pickGatewayUrl({
      env: "https://env.example.com",
      options: "https://options.example.com",
      stored: "https://stored.example.com",
    });
    expect(result).toEqual({
      url: "https://env.example.com",
      source: "env",
    });
  });

  it("prefers options over stored", () => {
    const result = pickGatewayUrl({
      options: "https://options.example.com",
      stored: "https://stored.example.com",
    });
    expect(result).toEqual({
      url: "https://options.example.com",
      source: "options",
    });
  });

  it("uses stored when nothing else is available", () => {
    const result = pickGatewayUrl({ stored: "https://stored.example.com" });
    expect(result).toEqual({
      url: "https://stored.example.com",
      source: "stored-credential",
    });
  });

  it("returns null when nothing is available", () => {
    expect(pickGatewayUrl({})).toBeNull();
  });
});

describe("readStoredCredentialGatewayUrl", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "actsis-litellm-gw-url-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeAuth(name: string, data: unknown) {
    const authPath = path.join(tmpDir, name);
    await mkdir(tmpDir, { recursive: true });
    await writeFile(authPath, JSON.stringify(data, null, 2));
    return authPath;
  }

  it("extracts and upgrades an http token endpoint origin to https", async () => {
    const authPath = await writeAuth("auth.json", {
      "actsis-litellm": {
        type: "oauth",
        access: "a",
        refresh: "r",
        tokenEndpoint: "http://gateway.example.com/token",
      },
    });

    const url = await readStoredCredentialGatewayUrl(
      authPath,
      "actsis-litellm",
    );
    expect(url).toBe("https://gateway.example.com");
  });

  it("returns null for a missing auth file", async () => {
    const url = await readStoredCredentialGatewayUrl(
      path.join(tmpDir, "missing-auth.json"),
      "actsis-litellm",
    );
    expect(url).toBeNull();
  });

  it("returns null when the provider entry is absent", async () => {
    const authPath = await writeAuth("auth.json", {
      "other-provider": {
        type: "oauth",
        tokenEndpoint: "https://other.example.com/token",
      },
    });

    const url = await readStoredCredentialGatewayUrl(
      authPath,
      "actsis-litellm",
    );
    expect(url).toBeNull();
  });

  it("returns null for an invalid token endpoint", async () => {
    const authPath = await writeAuth("auth.json", {
      "actsis-litellm": {
        type: "oauth",
        tokenEndpoint: "not-a-url",
      },
    });

    const url = await readStoredCredentialGatewayUrl(
      authPath,
      "actsis-litellm",
    );
    expect(url).toBeNull();
  });

  it("returns null for invalid JSON", async () => {
    const authPath = await writeAuth("bad.json", "not json");

    const url = await readStoredCredentialGatewayUrl(
      authPath,
      "actsis-litellm",
    );
    expect(url).toBeNull();
  });
});

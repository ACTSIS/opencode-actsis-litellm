import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  IMAGE_DEFAULT_MODEL,
  fetchImageGeneration,
  imageTimeoutMs,
  parseImageArgs,
  saveImageB64,
} from "../src/image.ts";
import { AuthError, CommandError, ImageError } from "../src/errors.ts";
import { buildImageToolInfos, IMAGE_COMMAND_TOOL_NAME } from "../src/image-tool.ts";
import { buildCommandDefinitions } from "../src/plugin.ts";
import type { ToolContentPart } from "../src/tools.ts";

const ONE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

describe("parseImageArgs", () => {
  it("defaults to 512 with the pixel-art model", () => {
    expect(parseImageArgs("a dragon")).toEqual({
      prompt: "a dragon",
      size: "512x512",
      model: IMAGE_DEFAULT_MODEL,
    });
  });

  it("accepts the --size flag anywhere in the args", () => {
    const parsed = parseImageArgs("a --size 1024 red dragon");
    expect(parsed.size).toBe("1024x1024");
    expect(parsed.prompt).toBe("a red dragon");
  });

  it("rejects an unsupported size", () => {
    expect(() => parseImageArgs("a dragon --size 640")).toThrow(CommandError);
    expect(() => parseImageArgs("a dragon --size 640")).toThrow(
      'Unsupported size "640" (allowed: 512, 768, 1024)',
    );
  });

  it("rejects an empty prompt with the usage line", () => {
    expect(() => parseImageArgs("")).toThrow("Usage: image <prompt> [--size 512|768|1024]");
    expect(() => parseImageArgs("--size 768")).toThrow(CommandError);
  });
});

describe("imageTimeoutMs", () => {
  it("floors the request timeout at 180 s", () => {
    expect(imageTimeoutMs(30_000)).toBe(180_000);
    expect(imageTimeoutMs(undefined)).toBe(180_000);
  });

  it("keeps a larger configured timeout", () => {
    expect(imageTimeoutMs(600_000)).toBe(600_000);
  });
});

describe("fetchImageGeneration", () => {
  it("posts the documented generations body and returns the b64 payloads", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ data: [{ b64_json: ONE_PNG }] }), {
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await fetchImageGeneration(
      "https://gw.example.com/",
      "sk-test",
      { prompt: "a dragon", model: IMAGE_DEFAULT_MODEL, size: "512x512" },
      30_000,
      fetchImpl,
    );

    expect(result).toEqual({
      images: [ONE_PNG],
      model: IMAGE_DEFAULT_MODEL,
      size: "512x512",
    });
    expect(calls[0].url).toBe("https://gw.example.com/v1/images/generations");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      model: IMAGE_DEFAULT_MODEL,
      prompt: "a dragon",
      n: 1,
      size: "512x512",
      output_format: "png",
    });
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
  });

  it("maps 401/403 to AuthError with the re-login hint", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    await expect(
      fetchImageGeneration("https://gw.example.com", "sk-test", {
        prompt: "x",
        model: IMAGE_DEFAULT_MODEL,
        size: "512x512",
      }, undefined, fetchImpl),
    ).rejects.toThrow(AuthError);
  });

  it("reports the status and the spend hint on other failures", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("boom", { status: 500, statusText: "Internal Server Error" }),
    ) as unknown as typeof fetch;
    await expect(
      fetchImageGeneration("https://gw.example.com", "sk-test", {
        prompt: "x",
        model: IMAGE_DEFAULT_MODEL,
        size: "512x512",
      }, undefined, fetchImpl),
    ).rejects.toThrow(/Image generation failed: 500: Internal Server Error \(spend, if any/);
  });

  it("rejects an empty data[] payload instead of returning nothing", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ data: [] })),
    ) as unknown as typeof fetch;
    await expect(
      fetchImageGeneration("https://gw.example.com", "sk-test", {
        prompt: "x",
        model: IMAGE_DEFAULT_MODEL,
        size: "512x512",
      }, undefined, fetchImpl),
    ).rejects.toThrow(ImageError);
  });
});

describe("saveImageB64", () => {
  it("decodes the payload into a png file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "actsis-image-save-"));
    try {
      const filePath = await saveImageB64(ONE_PNG, dir);
      expect(filePath.endsWith(".png")).toBe(true);
      const bytes = await readFile(filePath);
      expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("actsis_litellm_image tool", () => {
  let tmpDir: string;
  let authPath: string;
  let imageDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "actsis-image-tool-"));
    imageDir = path.join(tmpDir, "images");
    authPath = path.join(tmpDir, "auth.json");
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
    await rm(tmpDir, { recursive: true, force: true });
  });

  function imageTool(fetchImpl?: typeof fetch) {
    const info = buildImageToolInfos({
      providerId: "actsis-litellm",
      stateDir: tmpDir,
      authPath,
      imageSaveDir: imageDir,
      fetchImpl,
    }).find((t) => t.name === IMAGE_COMMAND_TOOL_NAME)!;
    return (input: Record<string, unknown>) =>
      info.execute(input, {}) as Promise<{ content: string | ReadonlyArray<ToolContentPart> }>;
  }

  it("is registered with the documented command surface", () => {
    expect(IMAGE_COMMAND_TOOL_NAME).toBe("actsis_litellm_image");
    const infos = buildImageToolInfos({ providerId: "actsis-litellm" });
    expect(infos.map((t) => t.name)).toContain(IMAGE_COMMAND_TOOL_NAME);
    const command = buildCommandDefinitions().find((c) => c.name === "actsis-litellm-image");
    expect(command).toBeDefined();
    expect(command!.template).toContain("actsis_litellm_image");
  });

  it("returns the login hint when no credential is stored", async () => {
    await rm(authPath);
    const result = await imageTool()({ args: "a dragon" });
    expect(result.content).toBe("Not signed in — run /login and choose ACTSIS LiteLLM.");
  });

  it("returns the usage line for empty args without calling the gateway", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await imageTool(fetchImpl)({ args: "  " });
    expect(result.content).toBe("Usage: image <prompt> [--size 512|768|1024]");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("generates, persists the png, and returns text plus a file part", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ data: [{ b64_json: ONE_PNG }] })),
    ) as unknown as typeof fetch;

    const result = await imageTool(fetchImpl)({ args: "a dragon --size 768" });
    expect(Array.isArray(result.content)).toBe(true);
    const parts = result.content as ToolContentPart[];

    expect(parts[0]).toEqual({
      type: "text",
      text: `image "a dragon" — ${IMAGE_DEFAULT_MODEL} 768x768`,
    });
    const filePart = parts.find((p) => p.type === "file");
    expect(filePart).toBeDefined();
    const file = filePart as { type: "file"; uri: string; mime: string; name?: string };
    expect(file.mime).toBe("image/png");
    expect(file.uri.startsWith("file://")).toBe(true);
    const savedPath = decodeURIComponent(new URL(file.uri).pathname);
    expect((await readFile(savedPath)).subarray(0, 4).toString("hex")).toBe("89504e47");

    const tail = parts[parts.length - 1] as { type: "text"; text: string };
    expect(tail.text).toContain(savedPath);
  });

  it("reports gateway failures as text instead of throwing", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("boom", { status: 503, statusText: "Unavailable" }),
    ) as unknown as typeof fetch;
    const result = await imageTool(fetchImpl)({ args: "a dragon" });
    expect(result.content).toMatch(/Image generation failed: 503/);
  });
});

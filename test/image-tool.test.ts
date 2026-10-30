import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  EDIT_MODEL_HINT,
  IMAGE_TOOL_NAME,
  ImageSessionStore,
  buildImageToolInfos,
  discoverImageModels,
  extractImageModelIds,
  fetchImageEdit,
  imageToolTimeoutMs,
  resolveImageInput,
  resolveImageModel,
} from "../src/image-tool.ts";
import type { ToolContentPart } from "../src/tools.ts";

const ONE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

describe("extractImageModelIds", () => {
  it("keeps only image_generation models, including model_info.mode", () => {
    expect(
      extractImageModelIds({
        data: [
          { id: "gpt-4", mode: "chat" },
          { id: "sdxl-pixel-art", mode: "image_generation" },
          { id: "qwen-image-edit", model_info: { mode: "image_generation" } },
          { id: "text-embedding-3", mode: "embedding" },
          { id: "no-mode-entry" },
        ],
      }),
    ).toEqual(["sdxl-pixel-art", "qwen-image-edit"]);
  });

  it("tolerates malformed bodies", () => {
    expect(extractImageModelIds(null)).toEqual([]);
    expect(extractImageModelIds({})).toEqual([]);
    expect(extractImageModelIds({ data: "nope" })).toEqual([]);
  });
});

describe("discoverImageModels", () => {
  it("asks /v1/models for the image-mode models", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({ data: [{ id: "sdxl-pixel-art", mode: "image_generation" }] }),
      );
    }) as unknown as typeof fetch;

    const models = await discoverImageModels("https://gw.example.com/", "sk-test", 5_000, fetchImpl);
    expect(models).toEqual([{ id: "sdxl-pixel-art" }]);
    expect(calls[0]).toBe("https://gw.example.com/v1/models?include_metadata=true");
  });

  it("returns an empty list when the gateway or the JSON fails", async () => {
    const failing = vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    expect(await discoverImageModels("https://gw.example.com", "k", 1_000, failing)).toEqual([]);

    const notJson = vi.fn(async () => new Response("not json")) as unknown as typeof fetch;
    expect(await discoverImageModels("https://gw.example.com", "k", 1_000, notJson)).toEqual([]);
  });
});

describe("resolveImageModel (selection policy, pi #47 v2 S2)", () => {
  const discovered = ["sdxl-pixel-art", "qwen-image-edit"];

  it("honors an explicit model, prefix-matching the discovered list", () => {
    expect(resolveImageModel("qwen-image-edit", false, discovered)).toEqual({
      model: "qwen-image-edit",
      askedHint: false,
    });
    expect(resolveImageModel("qwen", false, discovered).model).toBe("qwen-image-edit");
    expect(resolveImageModel("custom-model", false, discovered).model).toBe("custom-model");
  });

  it("prefers the editing-capable model when an image input is present", () => {
    const chosen = resolveImageModel(undefined, true, discovered);
    expect(chosen.model).toBe("qwen-image-edit");
    expect(chosen.model).toContain(EDIT_MODEL_HINT);
    expect(chosen.askedHint).toBe(true);
  });

  it("defaults to sdxl-pixel-art for text-to-image", () => {
    expect(resolveImageModel(undefined, false, discovered)).toEqual({
      model: "sdxl-pixel-art",
      askedHint: false,
    });
    expect(resolveImageModel(undefined, false, []).model).toBe("sdxl-pixel-art");
  });

  it("falls back to the first discovered model when the default is absent", () => {
    expect(resolveImageModel(undefined, false, ["flux-dev"])).toEqual({
      model: "flux-dev",
      askedHint: true,
    });
  });
});

describe("imageToolTimeoutMs (adaptive, pi #47 v2 S4)", () => {
  it("gives Qwen the long budgets and everything else the 180 s floor", () => {
    expect(imageToolTimeoutMs("qwen-image-edit", "512x512")).toBe(300_000);
    expect(imageToolTimeoutMs("qwen-image-edit", "768x768")).toBe(300_000);
    expect(imageToolTimeoutMs("qwen-image-edit", "1024x1024")).toBe(600_000);
    expect(imageToolTimeoutMs("sdxl-pixel-art", "512x512")).toBe(180_000);
    expect(imageToolTimeoutMs("sdxl-pixel-art", "1024x1024")).toBe(180_000);
  });
});

describe("image input resolution (pi #47 v2 S3)", () => {
  it("resolves 'last' from the session store", async () => {
    const store = new ImageSessionStore();
    store.set({ data: ONE_PNG, mimeType: "image/png" });
    await expect(resolveImageInput("last", store)).resolves.toMatchObject({
      data: ONE_PNG,
      mimeType: "image/png",
    });
  });

  it("fails clearly when there is no previous image", async () => {
    await expect(resolveImageInput("last", new ImageSessionStore())).rejects.toThrow(
      /No previous image in this session/,
    );
  });

  it("reads a file path and maps its mime type", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "actsis-image-input-"));
    try {
      const file = path.join(dir, "input.png");
      await writeFile(file, Buffer.from(ONE_PNG, "base64"));
      const resolved = await resolveImageInput(file, new ImageSessionStore());
      expect(resolved.mimeType).toBe("image/png");
      expect(resolved.data).toBe(ONE_PNG);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unsupported extension", async () => {
    await expect(resolveImageInput("/tmp/input.gif", new ImageSessionStore())).rejects.toThrow(
      /Unsupported image type ".gif"/,
    );
  });
});

describe("fetchImageEdit (multipart, pi #53)", () => {
  it("sends the reference image under the image[] field", async () => {
    let captured: FormData | undefined;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      captured = init?.body as FormData;
      return new Response(JSON.stringify({ data: [{ b64_json: ONE_PNG }] }));
    }) as unknown as typeof fetch;

    const result = await fetchImageEdit(
      "https://gw.example.com",
      "sk-test",
      {
        model: "qwen-image-edit",
        prompt: "make it 3D",
        image: { data: ONE_PNG, mimeType: "image/png" },
      },
      1_000,
      fetchImpl,
    );

    expect(result.images).toEqual([ONE_PNG]);
    expect(captured).toBeInstanceOf(FormData);
    expect(captured!.get("model")).toBe("qwen-image-edit");
    expect(captured!.get("prompt")).toBe("make it 3D");
    expect(captured!.get("n")).toBe("1");
    const file = captured!.get("image[]");
    expect(file).toBeInstanceOf(Blob);
    expect(captured!.get("files")).toBeNull();
    // The edits passthrough only needs model/prompt/n/image[] (pi parity).
    expect(captured!.get("size")).toBeNull();
  });
});

describe("actsis_litellm_generate_image tool", () => {
  let tmpDir: string;
  let authPath: string;
  let imageDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "actsis-gen-image-"));
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

  function generateTool(opts: { fetchImpl?: typeof fetch; imageModels?: string[]; store?: ImageSessionStore } = {}) {
    const info = buildImageToolInfos({
      providerId: "actsis-litellm",
      stateDir: tmpDir,
      authPath,
      imageSaveDir: imageDir,
      imageModels: opts.imageModels,
      store: opts.store,
      fetchImpl: opts.fetchImpl,
    }).find((t) => t.name === IMAGE_TOOL_NAME)!;
    return {
      info,
      run: (input: Record<string, unknown>) =>
        info.execute(input, {}) as Promise<{
          content: string | ReadonlyArray<ToolContentPart>;
          metadata?: Record<string, unknown>;
        }>,
    };
  }

  function gateway(handler: (url: URL, init?: RequestInit) => Response) {
    return vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
      handler(new URL(String(input)), init),
    ) as unknown as typeof fetch;
  }

  it("uses a model-safe tool name and the documented parameters", () => {
    expect(IMAGE_TOOL_NAME).toBe("actsis_litellm_generate_image");
    expect(IMAGE_TOOL_NAME).toMatch(/^[a-zA-Z0-9_.-]+$/);

    const { info } = generateTool();
    expect(Object.keys(info.input.properties)).toEqual(["prompt", "size", "model", "image"]);
  });

  it("carries the discovered image models in its description", () => {
    const { info } = generateTool({ imageModels: ["sdxl-pixel-art", "qwen-image-edit"] });
    expect(info.description).toContain("sdxl-pixel-art");
    expect(info.description).toContain("qwen-image-edit");
    expect(info.description).toContain("FROM SCRATCH");

    const undiscovered = generateTool();
    expect(undiscovered.info.description).toContain("discover at call time");
  });

  it("generates from scratch, saves the png and stores it for follow-up edits", async () => {
    const store = new ImageSessionStore();
    const fetchImpl = gateway((url) => {
      if (url.pathname === "/v1/models") {
        return new Response(
          JSON.stringify({
            data: [
              { id: "sdxl-pixel-art", mode: "image_generation" },
              { id: "qwen-image-edit", mode: "image_generation" },
            ],
          }),
        );
      }
      return new Response(JSON.stringify({ data: [{ b64_json: ONE_PNG }] }));
    });

    const { run } = generateTool({ fetchImpl, store });
    const result = await run({ prompt: "un zorro rojo", size: "1024" });

    const parts = result.content as ToolContentPart[];
    expect(parts[0]).toEqual({ type: "text", text: 'generate_image "un zorro rojo" — sdxl-pixel-art 1024x1024' });
    expect(parts.some((p) => p.type === "file")).toBe(true);
    expect(result.metadata).toMatchObject({ model: "sdxl-pixel-art", size: "1024x1024" });
    expect(store.get()).toMatchObject({ data: ONE_PNG, mimeType: "image/png" });
  });

  it("edits the last image through /v1/images/edits with an explicit model", async () => {
    const store = new ImageSessionStore();
    store.set({ data: ONE_PNG, mimeType: "image/png", filePath: "/tmp/last.png" });

    const paths: string[] = [];
    const fetchImpl = gateway((url) => {
      paths.push(url.pathname);
      if (url.pathname === "/v1/models") {
        return new Response(
          JSON.stringify({ data: [{ id: "qwen-image-edit", mode: "image_generation" }] }),
        );
      }
      return new Response(JSON.stringify({ data: [{ b64_json: ONE_PNG }] }));
    });

    const { run } = generateTool({ fetchImpl, store });
    const result = await run({ prompt: "hacelo 3D", image: "last", size: "512" });

    expect(paths).toContain("/v1/images/edits");
    expect(paths).not.toContain("/v1/images/generations");
    const parts = result.content as ToolContentPart[];
    expect(parts[0]).toEqual({ type: "text", text: 'generate_image "hacelo 3D" (edit) — qwen-image-edit 512x512' });
    expect(result.metadata).toMatchObject({ model: "qwen-image-edit", edited: true });
  });

  it("reports the failure as text without throwing", async () => {
    const fetchImpl = gateway(() => new Response("boom", { status: 500, statusText: "Boom" }));
    const { run } = generateTool({ fetchImpl });
    const result = await run({ prompt: "x" });
    expect(result.content).toMatch(/Image generation failed: 500/);
  });

  it("reports the saved png path so the model can relay it", async () => {
    const fetchImpl = gateway(() => new Response(JSON.stringify({ data: [{ b64_json: ONE_PNG }] })));
    const { run } = generateTool({ fetchImpl });
    const result = await run({ prompt: "x" });
    const parts = result.content as ToolContentPart[];
    const tail = parts[parts.length - 1] as { type: "text"; text: string };
    const filePath = String((result.metadata as { filePath?: string }).filePath);
    expect(tail.text).toContain(filePath);
    expect((await readFile(filePath)).subarray(0, 4).toString("hex")).toBe("89504e47");
  });
});

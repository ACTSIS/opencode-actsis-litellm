import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CANCEL_IMAGE_TOOL_NAME,
  IMAGE_COMMAND_TOOL_NAME,
  IMAGE_TOOL_NAME,
  ImageSessionStore,
  buildImageToolInfos,
  type SyntheticDelivery,
} from "../src/image-tool.ts";
import { ImageJobRegistry } from "../src/image-jobs.ts";

const ONE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

/** Fetch stub: `/v1/models` answers at once, generations stay pending until told. */
function gatedFetch() {
  const pending: Array<{ reject: (err: unknown) => void; resolve: () => void }> = [];
  const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/v1/models")) {
      return Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: "sdxl-pixel-art", mode: "image_generation" }] })),
      );
    }
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
      pending.push({
        reject,
        resolve: () =>
          resolve(
            new Response(JSON.stringify({ data: [{ b64_json: ONE_PNG }] }), {
              headers: { "Content-Type": "application/json" },
            }),
          ),
      });
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, pending };
}

async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("detached image renders", () => {
  let tmpDir: string;
  let authPath: string;
  let imageDir: string;
  let registry: ImageJobRegistry;
  let delivered: SyntheticDelivery[];
  let warnings: string[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "actsis-image-bg-"));
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
    registry = new ImageJobRegistry();
    delivered = [];
    warnings = [];
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function tools(opts: { fetchImpl?: typeof fetch; store?: ImageSessionStore } = {}) {
    const infos = buildImageToolInfos({
      providerId: "actsis-litellm",
      stateDir: tmpDir,
      authPath,
      imageSaveDir: imageDir,
      imageModels: ["sdxl-pixel-art"],
      fetchImpl: opts.fetchImpl,
      store: opts.store,
      registry,
      deliverSynthetic: (message) => {
        delivered.push(message);
      },
      warn: (message) => {
        warnings.push(message);
      },
    });
    const run = (name: string) => (input: Record<string, unknown>, context = {}) =>
      infos.find((t) => t.name === name)!.execute(input, context) as Promise<{
        content: string | ReadonlyArray<{ type: string; text?: string }>;
        metadata?: Record<string, unknown>;
      }>;
    return {
      generate: run(IMAGE_TOOL_NAME),
      image: run(IMAGE_COMMAND_TOOL_NAME),
      cancel: run(CANCEL_IMAGE_TOOL_NAME),
    };
  }

  function text(result: { content: string | ReadonlyArray<{ type: string; text?: string }> }): string {
    if (typeof result.content === "string") return result.content;
    return result.content.map((part) => part.text ?? "").join("\n");
  }

  it("returns a queued job immediately and does not wait for the render (S3/S4)", async () => {
    const { fetchImpl, pending } = gatedFetch();
    const { generate } = tools({ fetchImpl });

    const result = await generate(
      { prompt: "a dragon", background: true },
      { sessionID: "ses-1" },
    );

    expect(text(result)).toBe(
      "Image render queued as img-1 (sdxl-pixel-art 512x512). The image will appear in the conversation by itself when it is ready. Do not call the tool again for the same prompt.",
    );
    expect(result.metadata).toMatchObject({ jobId: "img-1", background: true });
    expect(pending).toHaveLength(1);
    expect(registry.active().map((j) => j.id)).toEqual(["img-1"]);
  });

  it("delivers the finished image as a synthetic message and updates 'last' (S5)", async () => {
    const { fetchImpl, pending } = gatedFetch();
    const store = new ImageSessionStore();
    const { generate } = tools({ fetchImpl, store });

    await generate({ prompt: "a dragon", background: true }, { sessionID: "ses-1" });
    pending[0].resolve();
    await settle();

    expect(delivered).toHaveLength(1);
    const message = delivered[0];
    expect(message.sessionID).toBe("ses-1");
    expect(message.text).toContain('generate_image "a dragon" — sdxl-pixel-art 512x512');
    expect(message.text).toContain("![generated image](");
    const saved = store.get("ses-1");
    expect(saved?.mimeType).toBe("image/png");
    expect(saved?.filePath).toBeDefined();
    expect(message.text).toContain(saved!.filePath!);
    // The delivered png exists on disk, so the link is not dead.
    const bytes = await readFile(saved!.filePath!);
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    // Slot released and the job kept as done (not active any more).
    expect(registry.active()).toHaveLength(0);
    expect(registry.running()).toHaveLength(0);
  });

  it("delivers a failure message, warns, and frees the slot (S6)", async () => {
    const { fetchImpl, pending } = gatedFetch();
    const { generate } = tools({ fetchImpl });

    await generate({ prompt: "a dragon", background: true }, { sessionID: "ses-1" });
    pending[0].reject(new Error("gateway exploded"));
    await settle();

    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).toBe(
      "img-1 failed: Failed to reach gateway images endpoint: gateway exploded",
    );
    expect(warnings.join("\n")).toContain(
      "img-1 failed: Failed to reach gateway images endpoint: gateway exploded",
    );
    expect(registry.active()).toHaveLength(0);
  });

  it("aborts a detached render through its own controller (S7)", async () => {
    const { fetchImpl, pending } = gatedFetch();
    const { generate, cancel } = tools({ fetchImpl });

    await generate({ prompt: "a dragon", background: true }, { sessionID: "ses-1" });
    await settle();
    const result = await cancel({ args: "img-1" });
    await settle();

    expect(text(result)).toContain("Aborted image render img-1 (sdxl-pixel-art 512x512)");
    expect(text(result)).toContain("may keep running on the gateway GPU");
    expect(pending).toHaveLength(1);
    expect(registry.active()).toHaveLength(0);
    // Cancellation was already reported by the cancel tool: no dupe message.
    expect(delivered).toHaveLength(0);
  });

  it("lists in-flight renders when cancel has no id (S8)", async () => {
    const { fetchImpl } = gatedFetch();
    const { generate, cancel } = tools({ fetchImpl });

    expect(text(await cancel({ args: "" }))).toBe("No image renders in flight.");
    await generate({ prompt: "a dragon", background: true }, { sessionID: "ses-1" });
    await settle();

    const listed = text(await cancel({}));
    expect(listed).toMatch(/^img-1: sdxl-pixel-art 512x512 running \(\d+s\)$/);
    await cancel({ args: "all" });
  });

  it("reports an unknown job id instead of pretending (S8)", async () => {
    const { cancel } = tools();
    expect(text(await cancel({ args: "img-404" }))).toBe(
      'No active image render with id "img-404".',
    );
  });

  it("refuses an edit on 'last' while a render of the same session is pending (S9)", async () => {
    const { fetchImpl, pending } = gatedFetch();
    const { generate } = tools({ fetchImpl });

    await generate({ prompt: "a dragon", background: true }, { sessionID: "ses-1" });
    // Another session is not blocked by ses-1's job.
    const other = await generate({ prompt: "x", image: "last" }, { sessionID: "ses-2" });
    expect(text(other)).toContain("No previous image in this session");

    const blocked = await generate({ prompt: "x", image: "last" }, { sessionID: "ses-1" });
    expect(text(blocked)).toBe(
      'An image render is still in flight as img-1. Wait for it to finish before referencing image="last".',
    );
    await generate({ prompt: "x", image: "last" }, { sessionID: "ses-1" });
    pending[0].resolve();
    await settle();
  });

  it("rejects a third concurrent render with the running ids (S11)", async () => {
    const { fetchImpl } = gatedFetch();
    const { generate } = tools({ fetchImpl });

    await generate({ prompt: "one", background: true }, { sessionID: "ses-1" });
    await settle();
    await generate({ prompt: "two", background: true }, { sessionID: "ses-1" });
    await settle();
    const rejected = await generate({ prompt: "three", background: true }, { sessionID: "ses-1" });

    expect(text(rejected)).toContain("Too many concurrent image renders (2/2)");
    expect(text(rejected)).toContain("img-1, img-2");
    expect(registry.active().map((j) => j.id)).toEqual(["img-1", "img-2"]);
  });

  it("accepts --background on the /image command surface (S3)", async () => {
    const { fetchImpl } = gatedFetch();
    const { image } = tools({ fetchImpl });

    const result = await image({ args: "a dragon --background" }, { sessionID: "ses-1" });

    expect(text(result)).toContain("Image render queued as img-1 (sdxl-pixel-art 512x512)");
    await settle();
    expect(registry.active().map((j) => j.id)).toEqual(["img-1"]);
  });

  it("keeps the blocking path untouched when background is absent (S3)", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("/v1/models")) {
        return new Response(
          JSON.stringify({ data: [{ id: "sdxl-pixel-art", mode: "image_generation" }] }),
        );
      }
      return new Response(JSON.stringify({ data: [{ b64_json: ONE_PNG }] }), {
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const { generate } = tools({ fetchImpl });

    const result = await generate({ prompt: "a dragon" }, { sessionID: "ses-1" });

    expect(text(result)).toContain('generate_image "a dragon" — sdxl-pixel-art 512x512');
    expect(delivered).toHaveLength(0);
    expect(registry.size).toBe(0);
  });

  it("skips synthetic delivery when the call carries no session id", async () => {
    const { fetchImpl, pending } = gatedFetch();
    const { generate } = tools({ fetchImpl });

    await generate({ prompt: "a dragon", background: true }, {});
    pending[0].resolve();
    await settle();

    expect(delivered).toHaveLength(0);
    expect(registry.active()).toHaveLength(0);
  });
});

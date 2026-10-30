import os from "node:os";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { ensureFreshToken } from "./gateway-client.ts";
import { readPluginState } from "./state.ts";
import { readEntry, type ToolContentPart, type ToolDeps, type ToolInfo, type ToolResult } from "./tools.ts";
import {
  IMAGE_DEFAULT_MODEL,
  fetchImageGeneration,
  parseImageArgs,
  saveImageB64,
  extractB64Images,
  type ImageGenerationResult,
} from "./image.ts";
import { AuthError, CommandError, ImageError } from "./errors.ts";
import { fetchFailureMessage } from "./network-error.ts";

/**
 * Image tools (mirror of pi #47). OpenCode commands are prompt templates that
 * delegate to a tool, so the `/image` command surface is the
 * `actsis_litellm_image` tool: it takes the raw command text (prompt plus
 * `--size`) and renders the result as a text summary plus a file part, with
 * the png always persisted so a host that cannot paint the part still has the
 * artifact (decision L2 in odd/tasks/parity-47-48.md).
 *
 * The model-callable `actsis_litellm_generate_image` tool (pi #47 v2, S9-S12)
 * discovers image models from the gateway, supports instruction-based editing
 * via multipart `image[]`, and keeps a session store so "last" refers to the
 * previous generated image.
 */

export interface ImageToolDeps extends ToolDeps {
  /** Override for the png directory (tests); defaults to the OS temp dir. */
  imageSaveDir?: string;
  /** Discovered image model ids for the generate_image tool description. */
  imageModels?: string[];
  /** Session store for follow-up edits; a fresh one is created when omitted. */
  store?: ImageSessionStore;
}

/** v2 model-callable image tool name (provider-safe charset, pi #56). */
export const IMAGE_TOOL_NAME = "actsis_litellm_generate_image";
export const EDIT_MODEL_HINT = "edit";

/**
 * The command-surface tool behind `/actsis-litellm-image` (T3): it takes the
 * raw command text and always generates with the gateway default model. The
 * model-callable tool above is the natural-language path (T4).
 */
export const IMAGE_COMMAND_TOOL_NAME = "actsis_litellm_image";

const LEGACY_IMAGE_INPUT = {
  type: "object" as const,
  properties: {
    args: {
      type: "string" as const,
      description:
        "The image request: the prompt, optionally followed by --size 512|768|1024 (default 512).",
    },
  },
  additionalProperties: false as const,
};

const GENERATE_IMAGE_INPUT = {
  type: "object" as const,
  properties: {
    prompt: {
      type: "string" as const,
      description: "Image description or edit instruction.",
    },
    size: {
      type: "string" as const,
      description: "Image size: 512, 768, 1024 or WIDTHxHEIGHT (default 512x512).",
    },
    model: {
      type: "string" as const,
      description: "Image model id from this description's list (e.g. sdxl-pixel-art, qwen-image-edit).",
    },
    image: {
      type: "string" as const,
      description: "Optional image input for edits: 'last' for the last generated image in this session, or a file path (png/jpg/webp).",
    },
  },
  required: ["prompt"] as const,
  additionalProperties: false as const,
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Relay-friendly result: summary, the image file part, and the saved path. */
export function imageResultParts(
  label: string,
  filePath: string | undefined,
): ToolContentPart[] {
  const parts: ToolContentPart[] = [{ type: "text", text: label }];
  if (filePath) {
    parts.push({
      type: "file",
      uri: pathToFileURL(filePath).href,
      mime: "image/png",
      name: path.basename(filePath),
    });
    parts.push({
      type: "text",
      text: `![generated image](${filePath})\nSaved copy: ${filePath}`,
    });
  } else {
    parts.push({ type: "text", text: "Image rendered in-session; the png copy could not be written." });
  }
  return parts;
}

export interface ImageModelOption {
  id: string;
}

interface ModelEntry {
  id?: unknown;
  mode?: unknown;
  model_info?: { mode?: unknown };
}

/** Map the gateway's /v1/models response to the available image model ids. */
export function extractImageModelIds(body: unknown): string[] {
  const data =
    body !== null &&
    typeof body === "object" &&
    Array.isArray((body as Record<string, unknown>).data)
      ? ((body as Record<string, unknown>).data as unknown[])
      : [];
  const ids: string[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as ModelEntry;
    const id = typeof e.id === "string" ? e.id : "";
    if (!id) continue;
    let mode: unknown = e.mode;
    if (mode === undefined && e.model_info && typeof e.model_info === "object") {
      mode = (e.model_info as { mode?: unknown }).mode;
    }
    if (mode === "image_generation") ids.push(id);
  }
  return ids;
}

/**
 * Discover image models from the gateway's `/v1/models` endpoint.
 * Returns an empty list (never throws) on network or JSON failures.
 */
export async function discoverImageModels(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 15_000,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ImageModelOption[]> {
  const normalized = baseUrl.replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetchImpl(`${normalized}/v1/models?include_metadata=true`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return [];
  }
  if (!response.ok) return [];
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return [];
  }
  return extractImageModelIds(body).map((id) => ({ id }));
}

/**
 * S9-S12 model selection policy:
 * - explicit `model` param wins (exact match, then prefix match, then passthrough)
 * - with an image input, pick the discovered editing-capable model
 * - otherwise default to sdxl-pixel-art when discovered is empty or contains it
 * - fall back to the first discovered model when the default is absent
 */
export function resolveImageModel(
  explicit: string | undefined,
  hasImageInput: boolean,
  discovered: string[] = [],
): { model: string; askedHint: boolean } {
  if (explicit && explicit.length > 0) {
    const model = discovered.includes(explicit)
      ? explicit
      : (discovered.find((m) => m.startsWith(explicit)) ?? explicit);
    return { model, askedHint: false };
  }
  if (hasImageInput) {
    const editModel =
      discovered.find((m) => m.toLowerCase().includes(EDIT_MODEL_HINT)) ??
      `qwen-image-${EDIT_MODEL_HINT}`;
    return { model: editModel, askedHint: true };
  }
  if (discovered.includes(IMAGE_DEFAULT_MODEL) || discovered.length === 0) {
    return { model: IMAGE_DEFAULT_MODEL, askedHint: false };
  }
  return { model: discovered[0], askedHint: true };
}

/** S11 adaptive timeout by model family and actual edit size. */
export function imageToolTimeoutMs(model: string, size: string): number {
  const width = parseInt(size.split("x")[0] ?? "512", 10);
  if (model.toLowerCase().includes("qwen")) {
    return Number.isFinite(width) && width >= 1024 ? 600_000 : 300_000;
  }
  return 180_000;
}

/** Session store for follow-up edits ("last" reference, S10). */
export interface SessionImage {
  data: string; // base64
  mimeType: string;
  filePath?: string;
}

export class ImageSessionStore {
  private last_: SessionImage | null = null;
  set(image: SessionImage): void {
    this.last_ = image;
  }
  get(): SessionImage | null {
    return this.last_;
  }
  clear(): void {
    this.last_ = null;
  }
}

const MIME_MAP = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
]);

/** Resolve the tool's image input: "last" (S10) or a filesystem path. */
export async function resolveImageInput(
  input: string,
  store: ImageSessionStore,
): Promise<SessionImage> {
  if (input === "last" || input === "última" || input === "last_image") {
    const prev = store.get();
    if (!prev) {
      throw new CommandError(
        "No previous image in this session: generate one first or pass a file path.",
      );
    }
    return prev;
  }
  const ext = path.extname(input).toLowerCase();
  const mimeType = MIME_MAP.get(ext);
  if (!mimeType) {
    throw new CommandError(
      `Unsupported image type "${ext || "(none)"}" (png/jpg/jpeg/webp expected)`,
    );
  }
  const data = (await readFile(input)).toString("base64");
  return { data, mimeType, filePath: input };
}

/** Multipart edit request (S10) — mirrors fetchImageGeneration's error shapes. */
export async function fetchImageEdit(
  baseUrl: string,
  apiKey: string,
  options: { model: string; prompt: string; image: SessionImage },
  timeoutMs?: number,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ImageGenerationResult> {
  const normalized = baseUrl.replace(/\/+$/, "");
  const form = new FormData();
  form.append("model", options.model);
  form.append("prompt", options.prompt);
  form.append("n", "1");
  // Field name matters all the way through LiteLLM's images/edits passthrough:
  // "files" / "image" are rejected; the upstream expects "image[]".
  form.append(
    "image[]",
    new Blob([Buffer.from(options.image.data, "base64")], { type: options.image.mimeType }),
    "input.png",
  );

  let response: Response;
  try {
    response = await fetchImpl(`${normalized}/v1/images/edits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs ?? 180_000),
    });
  } catch (err) {
    throw new ImageError(
      `Failed to reach gateway images edits endpoint: ${fetchFailureMessage(err)}`,
      { cause: err },
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new AuthError("Credential rejected by gateway. Run /login again.");
  }
  if (!response.ok) {
    throw new ImageError(
      `Image edit failed: ${response.status}: ${response.statusText}` +
        " (spend, if any, shows in the usage tool)",
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new ImageError(
      `Images edits response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const images = extractB64Images(body);
  if (images.length === 0) {
    throw new ImageError(
      "Images edits response had no b64_json payloads (model may have failed after billing)",
    );
  }

  // Edits carry no requested size (pi parity); report the payload honestly.
  return { images, model: options.model, size: "as-edited" };
}

function normalizeSize(size?: string): string {
  if (!size) return "512x512";
  const numeric = parseInt(size, 10);
  if (!Number.isNaN(numeric) && String(numeric) === size.trim()) {
    return `${numeric}x${numeric}`;
  }
  const match = size.match(/^(\d+)x(\d+)$/i);
  if (match) return `${match[1]}x${match[2]}`;
  return "512x512";
}

function toolDescription(models: string[]): string {
  const options =
    models.length > 0
      ? models.map((m) => `- ${m}`).join("\n")
      : "- (discover at call time — the gateway catalog defines the options)";
  return [
    "Generate or edit an image through the ACTSIS gateway (stable-diffusion.cpp models",
    "on the Strix Halo workstation). Use this tool when the user asks for an",
    "image in natural language, or to edit an existing image.",
    "EVERY model here accepts BOTH use cases unless its own description says",
    "otherwise: text-to-image generation FROM SCRATCH (no image param) AND",
    "instruction-based editing (with the image param). A model id with 'edit' in",
    "the name does NOT restrict it to editing.",
    "Known capabilities:",
    "- sdxl-pixel-art: text-to-image AND image inputs; style is BAKED IN",
    "  (always pixel-art, the prompt's style keywords don't change it) — use",
    "  it when the user wants pixel-art, or a fast/cheap render.",
    "- qwen-image-edit: text-to-image (free style — realistic, 3D, flat,",
    "  anything the prompt asks) AND instruction editing of a reference image;",
    "  slower and heavier (512 ~1 min, 1024 ~5.5 min per image).",
    "Style requests like 3D/realistic MUST go to a prompt-driven model",
    "(qwen-image-edit), never to sdxl-pixel-art.",
    "Discovered image models (ask the user which one they want when it is not",
    "obvious; edits need a reference image):",
    options,
    "Selection rules: an explicit `model` param wins; with an `image` input",
    "default to the editing-capable model (qwen-image-edit); otherwise the",
    "gateway default (sdxl-pixel-art). Report the rendered result and mention",
    "that large sizes are slower.",
  ].join("\n");
}

export function buildImageToolInfos(deps: ImageToolDeps): ToolInfo[] {
  const {
    stateDir,
    fetchImpl = globalThis.fetch,
    timeout,
    onRefreshed,
    imageModels,
    store: externalStore,
  } = deps;

  const store = externalStore ?? new ImageSessionStore();

  /** Resolve the gateway URL and a bearer token, or a user-facing reason. */
  const resolveContext = async (): Promise<
    { baseUrl: string; token: string } | { reason: string }
  > => {
    const entry = await readEntry(deps);
    if (!entry) {
      return { reason: "Not signed in — run /login and choose ACTSIS LiteLLM." };
    }
    const state = await readPluginState(stateDir);
    if (!state?.gatewayUrl) {
      return { reason: "Gateway URL not configured." };
    }
    if (entry.type === "api") {
      return { baseUrl: state.gatewayUrl, token: entry.key };
    }
    const token = await ensureFreshToken(
      { access: entry.access, refresh: entry.refresh, expires: entry.expires },
      { state, timeoutMs: timeout ?? 30_000, fetchImpl, onRefreshed },
    );
    return { baseUrl: state.gatewayUrl, token };
  };

  const legacyImage = async (args?: string): Promise<ToolResult> => {
    let parsed;
    try {
      parsed = parseImageArgs(args ?? "");
    } catch (err) {
      return { content: errorMessage(err) };
    }

    const resolved = await resolveContext().catch((err: unknown) => ({
      reason: `Image unavailable: ${errorMessage(err)}`,
    }));
    if ("reason" in resolved) return { content: resolved.reason };

    try {
      const result = await fetchImageGeneration(
        resolved.baseUrl,
        resolved.token,
        { prompt: parsed.prompt, model: parsed.model, size: parsed.size },
        timeout,
        fetchImpl,
      );
      const data = result.images[0];
      let filePath: string | undefined;
      try {
        filePath = await saveImageB64(data, deps.imageSaveDir ?? os.tmpdir());
      } catch {
        // Best effort: the image still renders from the file part.
      }
      store.set({ data, mimeType: "image/png", filePath });
      return {
        content: imageResultParts(
          `image "${parsed.prompt}" — ${result.model} ${result.size}`,
          filePath,
        ),
        metadata: { model: result.model, size: result.size, filePath },
      };
    } catch (err) {
      return { content: errorMessage(err) };
    }
  };

  const generateImage = async (
    input: Record<string, unknown>,
    context: unknown,
  ): Promise<ToolResult> => {
    const prompt =
      typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!prompt) {
      return { content: "A prompt is required." };
    }

    const size = normalizeSize(
      typeof input.size === "string" ? input.size : undefined,
    );
    const explicitModel =
      typeof input.model === "string" ? input.model : undefined;
    const imageInputArg =
      typeof input.image === "string" ? input.image : undefined;

    const resolved = await resolveContext().catch((err: unknown) => ({
      reason: `Image unavailable: ${errorMessage(err)}`,
    }));
    if ("reason" in resolved) return { content: resolved.reason };

    let imageInput: SessionImage | null = null;
    if (imageInputArg) {
      try {
        imageInput = await resolveImageInput(imageInputArg, store);
      } catch (err) {
        return { content: errorMessage(err) };
      }
    }

    const discovered = await discoverImageModels(
      resolved.baseUrl,
      resolved.token,
      timeout ?? 15_000,
      fetchImpl,
    ).catch(() => [] as ImageModelOption[]);
    const discoveredIds = discovered.map((m) => m.id);

    const { model } = resolveImageModel(
      explicitModel,
      imageInput !== null,
      discoveredIds,
    );

    // Best-effort progress notification (ignored if the host does not expose it).
    const progress = (context as { progress?: (message: string) => void }).progress;
    if (typeof progress === "function") {
      try {
        progress(
          `Generating ${size} image with ${model}${imageInput ? " (edit)" : ""} — this takes a while...`,
        );
      } catch {
        // ignore
      }
    }

    try {
      const timeoutMs = imageToolTimeoutMs(model, size);
      const result = imageInput
        ? await fetchImageEdit(
            resolved.baseUrl,
            resolved.token,
            { model, prompt, image: imageInput },
            timeoutMs,
            fetchImpl,
          )
        : await fetchImageGeneration(
            resolved.baseUrl,
            resolved.token,
            { prompt, model, size },
            timeoutMs,
            fetchImpl,
          );
      const data = result.images[0];
      let filePath: string | undefined;
      try {
        filePath = await saveImageB64(data, deps.imageSaveDir ?? os.tmpdir());
      } catch {
        // Best effort: the image still renders from the file part.
      }
      store.set({ data, mimeType: "image/png", filePath });
      const label = imageInput
        ? `generate_image "${prompt}" (edit) — ${model} ${size}`
        : `generate_image "${prompt}" — ${model} ${size}`;
      return {
        content: imageResultParts(label, filePath),
        metadata: { model, size, filePath, edited: imageInput !== null },
      };
    } catch (err) {
      return { content: errorMessage(err) };
    }
  };

  return [
    {
      name: IMAGE_COMMAND_TOOL_NAME,
      description:
        "Generate an image through the ACTSIS gateway (stable-diffusion.cpp models; the default " +
        `${IMAGE_DEFAULT_MODEL} renders pixel-art). Input is the user's raw request: the prompt, ` +
        "optionally followed by `--size 512|768|1024`. Generation is synchronous and slow (about " +
        "15-60 s at 512, several minutes at 1024). The result carries the rendered image and the " +
        "saved png path; relay that path to the user.",
      input: LEGACY_IMAGE_INPUT,
      async execute(input) {
        const args = typeof input.args === "string" ? input.args : undefined;
        return legacyImage(args);
      },
    },
    {
      name: IMAGE_TOOL_NAME,
      description: toolDescription(imageModels ?? []),
      input: GENERATE_IMAGE_INPUT,
      async execute(input, context) {
        return generateImage(input, context);
      },
    },
  ];
}

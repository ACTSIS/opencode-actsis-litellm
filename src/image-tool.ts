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
import { ImageJobRegistry, type ImageJob } from "./image-jobs.ts";
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
  /** Shared detached-job registry (pi #61 T1); a fresh one is created when omitted. */
  registry?: ImageJobRegistry;
  /**
   * Append a message to a session without starting a model turn (pi #61 S5).
   * The server plugin wires this to `session.synthetic(..., resume: false)`;
   * when omitted, finished renders are logged but never delivered.
   */
  deliverSynthetic?: (message: SyntheticDelivery) => Promise<void> | void;
  /** Failure log for detached renders (pi #61 S6); defaults to console.warn. */
  warn?: (message: string) => void;
}

/** v2 model-callable image tool name (provider-safe charset, pi #56). */
export const IMAGE_TOOL_NAME = "actsis_litellm_generate_image";
export const EDIT_MODEL_HINT = "edit";

/** Cancels or lists detached renders (pi #61 S8; replaces pi's cancel command). */
export const CANCEL_IMAGE_TOOL_NAME = "actsis_litellm_cancel_image";

/** Message appended to a session without starting a turn (pi #61 S5). */
export interface SyntheticDelivery {
  sessionID: string;
  text: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

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
        "The image request: the prompt, optionally followed by --size 512|768|1024 (default 512) and/or --background to render without blocking the turn.",
    },
  },
  additionalProperties: false as const,
};

const CANCEL_IMAGE_INPUT = {
  type: "object" as const,
  properties: {
    args: {
      type: "string" as const,
      description:
        "Optional job id to cancel, or 'all'. Omit it to list the renders currently in flight.",
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
    background: {
      type: "boolean" as const,
      description:
        "Render in the background and return a job id immediately. The image is delivered to the conversation by itself; do not call the tool again for the same prompt.",
    },
  },
  required: ["prompt"] as const,
  additionalProperties: false as const,
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Relay-friendly result: summary, the image file part, and the saved path.
 *
 * The png copy is best effort, but the image itself is NOT: when the write
 * fails the bytes still travel as an inline data URI and the text says so,
 * so a failed copy can never turn into a success-shaped result with no image.
 */
export function imageResultParts(
  label: string,
  filePath: string | undefined,
  data: string,
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
    return parts;
  }
  parts.push({
    type: "file",
    uri: `data:image/png;base64,${data}`,
    mime: "image/png",
    name: "image.png",
  });
  parts.push({
    type: "text",
    text: "The png copy could not be written; the image is attached inline (data URI) only.",
  });
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

/** Key for sessions that expose no id (single-session hosts and tests). */
export const DEFAULT_SESSION_KEY = "default";

/**
 * Session-keyed image store for follow-up edits. The plugin builds its tools
 * once, so one instance serves every session: "last" MUST be resolved per
 * session id or a server session would edit another session's image.
 */
export class ImageSessionStore {
  private last_ = new Map<string, SessionImage>();
  set(image: SessionImage, sessionId: string = DEFAULT_SESSION_KEY): void {
    this.last_.set(sessionId, image);
  }
  get(sessionId: string = DEFAULT_SESSION_KEY): SessionImage | null {
    return this.last_.get(sessionId) ?? null;
  }
  clear(sessionId: string = DEFAULT_SESSION_KEY): void {
    this.last_.delete(sessionId);
  }
}

/** Session identity of a tool call (absent on single-session hosts). */
export function sessionKey(context: unknown): string {
  const id = (context as { sessionID?: unknown } | null | undefined)?.sessionID;
  return typeof id === "string" && id ? id : DEFAULT_SESSION_KEY;
}

const MIME_MAP = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
]);

/** `image` values that mean "the last render of this session" (S9). */
export function isLastReference(input: string): boolean {
  return input === "last" || input === "última" || input === "last_image";
}

/** Resolve the tool's image input: "last" (S10) or a filesystem path. */
export async function resolveImageInput(
  input: string,
  store: ImageSessionStore,
  sessionId: string = DEFAULT_SESSION_KEY,
): Promise<SessionImage> {
  if (isLastReference(input)) {
    const prev = store.get(sessionId);
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
  signal?: AbortSignal,
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

  // The job owns its controller (pi #61 S7); the timeout stays a separate budget.
  const timeoutSignal = AbortSignal.timeout(timeoutMs ?? 180_000);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  let response: Response;
  try {
    response = await fetchImpl(`${normalized}/v1/images/edits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: combinedSignal,
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

export interface DetachedRenderOptions {
  registry: ImageJobRegistry;
  store: ImageSessionStore;
  imageSaveDir?: string;
  deliverSynthetic?: (message: SyntheticDelivery) => Promise<void> | void;
  warn?: (message: string) => void;
}

/** Queued acknowledgement of a detached render (pi #61 S4). */
export function queuedImageText(job: ImageJob, again: string): string {
  return (
    `Image render queued as ${job.id} (${job.model} ${job.size}). ` +
    `The image will appear in the conversation by itself when it is ready. ${again}`
  );
}

/**
 * Run an image job detached from the active turn (pi #61 T3/T4/T5).
 *
 * Delivery goes through `deliverSynthetic`, which the plugin wires to
 * `session.synthetic(..., resume: false)`: the finished image lands in the
 * transcript without starting a model turn. Every failure path keeps the
 * concurrency slot free, because the cap must never depend on a delivery
 * succeeding.
 */
export async function runDetachedImageJob(
  job: ImageJob,
  options: DetachedRenderOptions,
  label: string,
  fetcher: () => Promise<{ images: string[]; model: string; size?: string }>,
): Promise<void> {
  const { registry, store, imageSaveDir, deliverSynthetic, warn } = options;

  // Delivery is best effort: a torn-down host must never turn a finished
  // render into an unhandled rejection or a leaked slot.
  const deliver = (text: string, metadata?: Record<string, unknown>): void => {
    if (!deliverSynthetic || job.sessionID === DEFAULT_SESSION_KEY) return;
    try {
      void Promise.resolve(
        deliverSynthetic({
          sessionID: job.sessionID,
          text,
          description: `actsis-litellm image ${job.id}`,
          metadata,
        }),
      ).catch(() => {
        // The transcript entry is lost; the slot release below still runs.
      });
    } catch {
      // Stale host context: same handling as an async rejection.
    }
  };

  let outcome: "done" | "failed" = "failed";
  try {
    registry.start(job.id);
    const result = await fetcher();
    const data = result.images[0];
    let filePath: string | undefined;
    try {
      filePath = await saveImageB64(data, imageSaveDir ?? os.tmpdir());
    } catch {
      // Best effort copy; the render itself still succeeded.
    }
    store.set({ data, mimeType: "image/png", filePath }, job.sessionID);
    outcome = "done";
    const sizeText = result.size ? ` ${result.size}` : "";
    const text = filePath
      ? `${job.id}: ${label} — ${result.model}${sizeText}\n` +
        `![generated image](${filePath})\nSaved copy: ${filePath}`
      : `${job.id}: ${label} — ${result.model}${sizeText}\n` +
        "The png copy could not be written, so the image cannot be shown.";
    deliver(text, { jobId: job.id, model: result.model, filePath, background: true });
  } catch (err) {
    const current = registry.get(job.id);
    if (current?.status === "cancelled") {
      // Cancellation was already reported by the cancel tool; just free the slot.
    } else {
      const message = errorMessage(err);
      deliver(`${job.id} failed: ${message}`, { jobId: job.id, error: message });
      try {
        warn?.(`${job.id} failed: ${message}`);
      } catch {
        // Logging is informative only.
      }
    }
  } finally {
    // Release the slot unconditionally; a job cancelled meanwhile keeps its own
    // status and is dropped instead of being resurrected as done/failed.
    const current = registry.get(job.id);
    if (current?.status === "cancelled") {
      registry.remove(job.id);
    } else if (current && (current.status === "queued" || current.status === "running")) {
      registry.settle(job.id, outcome);
      if (outcome === "failed") registry.remove(job.id);
    }
  }
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
    registry: externalRegistry,
    deliverSynthetic,
    warn,
  } = deps;

  const store = externalStore ?? new ImageSessionStore();
  const registry = externalRegistry ?? new ImageJobRegistry();
  const warnFailure =
    warn ??
    ((message: string) => {
      console.warn(`[actsis-litellm] ${message}`);
    });

  const detachedOptions = (): DetachedRenderOptions => ({
    registry,
    store,
    imageSaveDir: deps.imageSaveDir,
    deliverSynthetic,
    warn: warnFailure,
  });

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

  const legacyImage = async (
    args: string | undefined,
    context?: unknown,
  ): Promise<ToolResult> => {
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

    if (parsed.background) {
      let job: ImageJob;
      try {
        job = registry.create(parsed.model, parsed.size, sessionKey(context));
      } catch (err) {
        return { content: errorMessage(err) };
      }
      void runDetachedImageJob(
        job,
        detachedOptions(),
        `image "${parsed.prompt}"`,
        () =>
          fetchImageGeneration(
            resolved.baseUrl,
            resolved.token,
            { prompt: parsed.prompt, model: parsed.model, size: parsed.size },
            timeout,
            fetchImpl,
            job.controller.signal,
          ),
      );
      return {
        content: queuedImageText(job, "Do not ask for the same image again."),
        metadata: { jobId: job.id, model: job.model, size: job.size, background: true },
      };
    }

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
      store.set({ data, mimeType: "image/png", filePath }, sessionKey(context));
      return {
        content: imageResultParts(
          `image "${parsed.prompt}" — ${result.model} ${result.size}`,
          filePath,
          data,
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
      // A pending render of this session owns "last": waiting is the only
      // honest answer (pi #61 S9).
      if (isLastReference(imageInputArg)) {
        const pending = registry.activeForSession(sessionKey(context))[0];
        if (pending) {
          return {
            content:
              `An image render is still in flight as ${pending.id}. ` +
              'Wait for it to finish before referencing image="last".',
          };
        }
      }
      try {
        imageInput = await resolveImageInput(
          imageInputArg,
          store,
          sessionKey(context),
        );
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
    if (!input.background && typeof progress === "function") {
      try {
        progress(
          `Generating ${size} image with ${model}${imageInput ? " (edit)" : ""} — this takes a while...`,
        );
      } catch {
        // ignore
      }
    }

    const timeoutMs = imageToolTimeoutMs(model, size);
    const fetchOnce = (signal?: AbortSignal) =>
      imageInput
        ? fetchImageEdit(
            resolved.baseUrl,
            resolved.token,
            { model, prompt, image: imageInput },
            timeoutMs,
            fetchImpl,
            signal,
          )
        : fetchImageGeneration(
            resolved.baseUrl,
            resolved.token,
            { prompt, model, size },
            timeoutMs,
            fetchImpl,
            signal,
          );

    if (input.background === true) {
      let job: ImageJob;
      try {
        job = registry.create(model, size, sessionKey(context));
      } catch (err) {
        return { content: errorMessage(err) };
      }
      void runDetachedImageJob(
        job,
        detachedOptions(),
        imageInput ? `generate_image "${prompt}" (edit)` : `generate_image "${prompt}"`,
        async () => {
          const result = await fetchOnce(job.controller.signal);
          return { images: result.images, model: result.model, size: result.size };
        },
      );
      return {
        content: queuedImageText(job, "Do not call the tool again for the same prompt."),
        metadata: { jobId: job.id, model, size, background: true },
      };
    }

    try {
      const result = await fetchOnce();
      const data = result.images[0];
      let filePath: string | undefined;
      try {
        filePath = await saveImageB64(data, deps.imageSaveDir ?? os.tmpdir());
      } catch {
        // Best effort: imageResultParts falls back to an inline data URI.
      }
      store.set({ data, mimeType: "image/png", filePath }, sessionKey(context));
      // Edits do not send a size (the upstream keeps the reference image's
      // dimensions), so the result must not claim one.
      const edited = imageInput !== null;
      const label = edited
        ? `generate_image "${prompt}" (edit) — ${model}`
        : `generate_image "${prompt}" — ${model} ${size}`;
      const parts = imageResultParts(label, filePath, data);
      if (edited && typeof input.size === "string" && input.size) {
        parts.push({
          type: "text",
          text: "size applies to generation only; the edit kept the reference image's dimensions.",
        });
      }
      return {
        content: parts,
        metadata: edited
          ? { model, filePath, edited: true }
          : { model, size, filePath, edited: false },
      };
    } catch (err) {
      return { content: errorMessage(err) };
    }
  };

  const cancelImage = async (input: Record<string, unknown>): Promise<ToolResult> => {
    const target = typeof input.args === "string" ? input.args.trim() : "";

    if (target === "all") {
      const ids = registry.cancelAll();
      if (ids.length === 0) return { content: "No image renders in flight." };
      return {
        content:
          `Aborted image renders: ${ids.join(", ")}. ` +
          "The render may keep running on the gateway GPU.",
      };
    }

    if (!target) {
      const lines = registry.describeActive();
      return { content: lines.length === 0 ? "No image renders in flight." : lines.join("\n") };
    }

    const job = registry.cancel(target);
    if (!job) {
      return { content: `No active image render with id "${target}".` };
    }
    return {
      content:
        `Aborted image render ${job.id} (${job.model} ${job.size}). ` +
        "The render may keep running on the gateway GPU.",
    };
  };

  return [
    {
      name: IMAGE_COMMAND_TOOL_NAME,
      description:
        "Generate an image through the ACTSIS gateway (stable-diffusion.cpp models; the default " +
        `${IMAGE_DEFAULT_MODEL} renders pixel-art). Input is the user's raw request: the prompt, ` +
        "optionally followed by `--size 512|768|1024` and/or `--background`. Generation is " +
        "synchronous and slow (about 15-60 s at 512, several minutes at 1024); with `--background` " +
        "it returns a job id immediately. The result carries the rendered image and the saved png " +
        "path; relay that path to the user.",
      input: LEGACY_IMAGE_INPUT,
      async execute(input, context) {
        const args = typeof input.args === "string" ? input.args : undefined;
        return legacyImage(args, context);
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
    {
      name: CANCEL_IMAGE_TOOL_NAME,
      description:
        "List the image renders currently in flight, or cancel one by id (or all). " +
        "The gateway renders on one GPU, so a cancelled render may keep running there.",
      input: CANCEL_IMAGE_INPUT,
      async execute(input) {
        return cancelImage(input);
      },
    },
  ];
}

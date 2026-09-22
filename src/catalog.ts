import {
  fetchModels,
  fetchModelInfo,
  type ModelsResponse,
} from "./client.ts";
import { CatalogError } from "./errors.ts";
import type { ActsisEnabledConfig } from "./config.ts";
import type { OpencodeModelConfig } from "./catalog-cache.ts";

const CHAT_MODES = new Set(["chat", "completion"]);
const NON_CHAT_MODES = new Set([
  "embedding",
  "audio_speech",
  "audio_transcription",
  "image_generation",
  "image_edit",
  "video_generation",
  "rerank",
  "moderations",
  "realtime",
]);

// Conservative name heuristic for when no mode metadata is available.
// NOTE: bare 'audio'/'speech' tokens are intentionally NOT in this list
// because they are too risky for legitimate chat models (e.g. gpt-4o-audio-preview).
// Gateways that return per-model mode metadata will still filter non-chat audio
// models via the metadata path.
const NON_CHAT_ID_RE =
  /(^|[-_/.])(embed|embedding|embeddings|whisper|tts|transcription|transcrib|rerank|reranker|moderation|moderations|speech|diarize|dall-e|dalle|imagegen|stable-diffusion)([-_/.]|$)/i;

export function isChatModelId(
  id: string,
  metadataMode?: string | null,
): boolean {
  if (typeof metadataMode === "string" && metadataMode.length > 0) {
    const mode = metadataMode.toLowerCase();
    if (CHAT_MODES.has(mode)) return true;
    if (NON_CHAT_MODES.has(mode)) return false;
  }
  return !NON_CHAT_ID_RE.test(id);
}

interface LiteLLMModelInfo {
  id?: string;
  input_cost_per_token?: number | null;
  output_cost_per_token?: number | null;
  cache_read_input_token_cost?: number | null;
  cache_creation_input_token_cost?: number | null;
  base_model?: unknown;
  max_tokens?: number | null;
  max_input_tokens?: number | null;
  max_output_tokens?: number | null;
  mode?: string | null;
  litellm_params?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export function extractMode(
  entry: Record<string, unknown> | LiteLLMModelInfo | undefined,
): string | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const mode = entry.mode;
  if (typeof mode === "string" && mode) return mode;
  const litellmParams = entry.litellm_params;
  if (litellmParams && typeof litellmParams === "object") {
    const lpMode = (litellmParams as Record<string, unknown>).mode;
    if (typeof lpMode === "string" && lpMode) return lpMode;
  }
  const metadata = entry.metadata;
  if (metadata && typeof metadata === "object") {
    const mdMode = (metadata as Record<string, unknown>).mode;
    if (typeof mdMode === "string" && mdMode) return mdMode;
  }
  return undefined;
}

function perMillion(value: number | null | undefined): number {
  if (value === undefined || value === null || !Number.isFinite(value)) return 0;
  return value * 1_000_000;
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

export function buildInfoMap(
  infoBody: unknown,
): Map<string, LiteLLMModelInfo> {
  const map = new Map<string, LiteLLMModelInfo>();
  if (!Array.isArray(infoBody)) return map;
  for (const entry of infoBody) {
    if (typeof entry !== "object" || entry === null) continue;
    const info = entry as LiteLLMModelInfo;
    const id = typeof info.id === "string" ? info.id : "";
    if (!id) continue;
    if (!map.has(id)) {
      map.set(id, info);
    }
  }
  return map;
}

export function infoToConfig(
  id: string,
  info: LiteLLMModelInfo | undefined,
): OpencodeModelConfig {
  const contextWindow = positiveInt(info?.max_input_tokens) ?? 128_000;
  const maxTokens = positiveInt(info?.max_output_tokens) ?? 16_384;

  return {
    name: id,
    tool_call: true,
    reasoning: true,
    limit: {
      context: contextWindow,
      output: maxTokens,
    },
    modalities: {
      input: ["text"],
      output: ["text"],
    },
    cost: {
      input: perMillion(info?.input_cost_per_token),
      output: perMillion(info?.output_cost_per_token),
      cache_read: perMillion(info?.cache_read_input_token_cost),
      cache_write: perMillion(info?.cache_creation_input_token_cost),
    },
  };
}

interface ModelsBody {
  data?: Array<Record<string, unknown>>;
}

/**
 * Pure mapping from LiteLLM /v1/models and optional /model/info bodies to
 * OpenCode ModelV2 configs. Exported so tests can exercise it without network.
 */
export function mapCatalogModels(
  modelsBody: ModelsBody,
  infoBody?: unknown,
): OpencodeModelConfig[] {
  if (!Array.isArray(modelsBody?.data)) {
    throw new CatalogError(
      "Gateway /v1/models response did not contain a data array",
    );
  }

  const infoMap = buildInfoMap(infoBody);
  const seen = new Set<string>();
  const models: OpencodeModelConfig[] = [];

  for (const entry of modelsBody.data) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = typeof entry.id === "string" ? entry.id : "";
    if (!id || seen.has(id)) continue;

    const infoEntry = infoMap.get(id);
    const mode = extractMode(entry) ?? extractMode(infoEntry);
    if (!isChatModelId(id, mode)) continue;

    seen.add(id);
    models.push(infoToConfig(id, infoEntry));
  }

  models.sort((a, b) => a.name.localeCompare(b.name));
  return models;
}

export async function fetchCatalogModels(
  config: ActsisEnabledConfig,
  apiKey: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<OpencodeModelConfig[]> {
  const modelsResult: ModelsResponse = await fetchModels(
    config.baseUrl,
    apiKey,
    config.requestTimeoutMs,
    fetchImpl,
  );

  let infoBody: unknown;
  try {
    const infoResult = await fetchModelInfo(
      config.baseUrl,
      apiKey,
      config.requestTimeoutMs,
      fetchImpl,
    );
    infoBody = infoResult.body;
  } catch {
    // Best-effort enrichment; proceed with default costs on failure.
    infoBody = undefined;
  }

  return mapCatalogModels(modelsResult.body as ModelsBody, infoBody);
}

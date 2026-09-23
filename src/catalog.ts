import {
  fetchModels,
  fetchModelInfo,
  fetchModelInfoV2,
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
  key?: string;
  model_name?: string;
  model_info?: LiteLLMModelInfo;
  input_cost_per_token?: number | null;
  output_cost_per_token?: number | null;
  cache_read_input_token_cost?: number | null;
  cache_creation_input_token_cost?: number | null;
  base_model?: unknown;
  max_tokens?: number | null;
  max_input_tokens?: number | null;
  max_output_tokens?: number | null;
  mode?: string | null;
  supports_vision?: boolean | null;
  supports_reasoning?: boolean | null;
  supports_function_calling?: boolean | null;
  reasoning_effort_levels?: unknown;
  litellm_params?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export function extractMode(
  entry: Record<string, unknown> | LiteLLMModelInfo | undefined,
): string | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const resolved = resolveModelInfo(entry);
  const mode = resolved.mode;
  if (typeof mode === "string" && mode) return mode;
  const litellmParams = resolved.litellm_params;
  if (litellmParams && typeof litellmParams === "object") {
    const lpMode = (litellmParams as Record<string, unknown>).mode;
    if (typeof lpMode === "string" && lpMode) return lpMode;
  }
  const metadata = resolved.metadata;
  if (metadata && typeof metadata === "object") {
    const mdMode = (metadata as Record<string, unknown>).mode;
    if (typeof mdMode === "string" && mdMode) return mdMode;
  }
  return undefined;
}

function resolveModelInfo(entry: LiteLLMModelInfo | undefined): LiteLLMModelInfo {
  if (!entry) return {};
  const nested = entry.model_info;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return { ...entry, ...nested };
  }
  return entry;
}

function infoMapKey(entry: LiteLLMModelInfo): string {
  if (typeof entry.model_name === "string" && entry.model_name) {
    return entry.model_name;
  }
  const nested = resolveModelInfo(entry);
  if (typeof nested.key === "string" && nested.key) {
    return nested.key;
  }
  return typeof entry.id === "string" && entry.id ? entry.id : "";
}

export const V2_PAGE_SIZE = 100;
export const V2_MAX_PAGES = 5;

const TIER_SUFFIXES: Array<[number, string]> = [
  [128_000, "128k"],
  [200_000, "200k"],
  [272_000, "272k"],
  [512_000, "512k"],
];

export interface CostTier {
  input: number;
  output: number;
  cache: { read: number; write: number };
  tier: { type: "context"; size: number };
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

function buildEffortVariants(
  levels: unknown,
): Record<string, { reasoningEffort: string }> | undefined {
  if (!Array.isArray(levels)) return undefined;
  const variants: Record<string, { reasoningEffort: string }> = {};
  for (const level of levels) {
    if (typeof level !== "string" || !level) continue;
    variants[level] = { reasoningEffort: level };
  }
  return Object.keys(variants).length > 0 ? variants : undefined;
}

export function buildInfoMap(
  infoBody: unknown,
): Map<string, LiteLLMModelInfo> {
  const map = new Map<string, LiteLLMModelInfo>();
  const entries = Array.isArray(infoBody)
    ? infoBody
    : infoBody !== null &&
        typeof infoBody === "object" &&
        Array.isArray((infoBody as Record<string, unknown>).data)
      ? ((infoBody as Record<string, unknown>).data as unknown[])
      : [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const info = entry as LiteLLMModelInfo;
    const id = infoMapKey(info);
    if (!id) continue;
    if (!map.has(id)) {
      map.set(id, info);
    }
  }
  return map;
}

function buildCostTiers(resolved: LiteLLMModelInfo): CostTier[] {
  const cacheRead = perMillion(resolved.cache_read_input_token_cost);
  const cacheWrite = perMillion(resolved.cache_creation_input_token_cost);
  const tiers: CostTier[] = [];
  for (const [size, suffix] of TIER_SUFFIXES) {
    const rawInput = resolved[`input_cost_per_token_above_${suffix}_tokens`];
    const rawOutput = resolved[`output_cost_per_token_above_${suffix}_tokens`];
    const input = typeof rawInput === "number" && Number.isFinite(rawInput) ? rawInput : undefined;
    const output = typeof rawOutput === "number" && Number.isFinite(rawOutput) ? rawOutput : undefined;
    if (input === undefined && output === undefined) continue;
    tiers.push({
      input: input !== undefined ? input * 1_000_000 : 0,
      output: output !== undefined ? output * 1_000_000 : 0,
      cache: { read: cacheRead, write: cacheWrite },
      tier: { type: "context", size },
    });
  }
  tiers.sort((a, b) => a.tier.size - b.tier.size);
  return tiers;
}

export function infoToConfig(
  id: string,
  info: LiteLLMModelInfo | undefined,
): OpencodeModelConfig {
  const resolved = resolveModelInfo(info);
  const contextWindow = positiveInt(resolved.max_input_tokens) ?? 128_000;
  const maxTokens = positiveInt(resolved.max_output_tokens) ?? 16_384;
  const input: string[] = ["text"];
  if (resolved.supports_vision === true) input.push("image");
  const variants = buildEffortVariants(resolved.reasoning_effort_levels);

  const tiers = buildCostTiers(resolved);

  return {
    name: id,
    tool_call: resolved.supports_function_calling !== false,
    reasoning: variants !== undefined || resolved.supports_reasoning !== false,
    limit: {
      context: contextWindow,
      output: maxTokens,
    },
    modalities: {
      input,
      output: ["text"],
    },
    cost: {
      input: perMillion(resolved.input_cost_per_token),
      output: perMillion(resolved.output_cost_per_token),
      cache_read: perMillion(resolved.cache_read_input_token_cost),
      cache_write: perMillion(resolved.cache_creation_input_token_cost),
      ...(tiers.length > 0 ? { tiers } : {}),
    },
    ...(variants ? { variants } : {}),
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

  let infoMap = new Map<string, LiteLLMModelInfo>();
  try {
    const infoResult = await fetchModelInfo(
      config.baseUrl,
      apiKey,
      config.requestTimeoutMs,
      fetchImpl,
    );
    infoMap = buildInfoMap(infoResult.body);
  } catch {
    // Fall through to the paginated v2 endpoint.
  }

  if (infoMap.size === 0) {
    try {
      const first = await fetchModelInfoV2(
        config.baseUrl,
        apiKey,
        config.requestTimeoutMs,
        1,
        V2_PAGE_SIZE,
        fetchImpl,
      );
      const firstBody =
        first.body !== null && typeof first.body === "object"
          ? (first.body as Record<string, unknown>)
          : null;
      if (firstBody) {
        const map = buildInfoMap(firstBody.data);
        for (const [key, value] of map) infoMap.set(key, value);

        const totalPages = positiveInt(firstBody.total_pages) ?? 1;
        const lastPage = Math.min(totalPages, V2_MAX_PAGES);
        for (let page = 2; page <= lastPage; page++) {
          const result = await fetchModelInfoV2(
            config.baseUrl,
            apiKey,
            config.requestTimeoutMs,
            page,
            V2_PAGE_SIZE,
            fetchImpl,
          );
          const pageMap = buildInfoMap(
            (result.body as Record<string, unknown> | null)?.data,
          );
          for (const [key, value] of pageMap) infoMap.set(key, value);
        }
      }
    } catch {
      // Best-effort enrichment; proceed with default costs on failure.
    }
  }

  return mapCatalogModels(modelsResult.body as ModelsBody, [
    ...infoMap.values(),
  ]);
}

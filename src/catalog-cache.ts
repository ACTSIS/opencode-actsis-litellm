import path from "node:path";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { renameSync } from "node:fs";
import os from "node:os";

const CACHE_SCHEMA_VERSION = 2;
const DEFAULT_APP_DIR_NAME = "opencode";
const DEFAULT_PLUGIN_DIR_NAME = "actsis-litellm";
const CACHE_FILE_NAME = "models-cache.json";

export interface OpencodeModelConfig {
  name: string;
  tool_call: boolean;
  reasoning: boolean;
  limit: {
    context: number;
    output: number;
  };
  modalities: {
    input: string[];
    output: string[];
  };
  cost?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
    tiers?: Array<{
      input: number;
      output: number;
      cache: { read: number; write: number };
      tier: { type: "context"; size: number };
    }>;
  };
  variants?: Record<string, { reasoningEffort: string }>;
}

interface CachedModelsFile {
  version: number;
  fetchedAt: number;
  models: Record<string, OpencodeModelConfig>;
  credential?: CachedCatalogScope;
}

/**
 * Which credential/scope fetched the cached catalog (mirror of pi #48 S3).
 * The gateway scopes `/v1/models` per consent-chosen team for OAuth sessions,
 * so a team-bound session legitimately lists an `oc/*`-only subset; users must
 * re-login (and pick another team) to widen it. Additive v2 field: readers
 * tolerate caches written before this existed.
 */
export interface CachedCatalogScope {
  kind: "oauth" | "api_key";
  userId?: string;
  teamId?: string;
}

function defaultPluginDir(): string {
  const dataHome = process.env.XDG_DATA_HOME
    ? process.env.XDG_DATA_HOME
    : path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, DEFAULT_APP_DIR_NAME, DEFAULT_PLUGIN_DIR_NAME);
}

function cachePath(dir?: string): string {
  return path.join(dir ?? defaultPluginDir(), CACHE_FILE_NAME);
}

export async function loadCachedModels(
  dir?: string,
): Promise<Record<string, OpencodeModelConfig> | null> {
  const file = cachePath(dir);
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const fileData = parsed as CachedModelsFile;
    if (fileData.version !== CACHE_SCHEMA_VERSION) {
      return null;
    }
    if (!Number.isFinite(fileData.fetchedAt)) {
      return null;
    }
    if (typeof fileData.models !== "object" || fileData.models === null) {
      return null;
    }
    return fileData.models;
  } catch {
    return null;
  }
}

export async function saveCachedModels(
  models: Record<string, OpencodeModelConfig>,
  dir?: string,
  credential?: CachedCatalogScope,
): Promise<void> {
  const file = cachePath(dir);
  await mkdir(path.dirname(file), { recursive: true });
  const tmpFile = `${file}.tmp.${process.pid}`;

  const toWrite: CachedModelsFile = {
    version: CACHE_SCHEMA_VERSION,
    fetchedAt: Date.now(),
    models,
    ...(credential ? { credential } : {}),
  };

  try {
    await writeFile(tmpFile, JSON.stringify(toWrite, null, 2), "utf8");
    renameSync(tmpFile, file);
  } catch (err) {
    try {
      await rm(tmpFile, { force: true });
    } catch {
      // Ignore cleanup failure.
    }
    throw err;
  }
}

/**
 * Derive the fetch scope from a v2 integration credential (structural shape,
 * so callers never import OpenCode runtime internals). Returns undefined when
 * there is no credential to describe.
 */
export function scopeFromCredential(
  credential:
    | { type: "oauth" | "key"; metadata?: Record<string, unknown> }
    | null
    | undefined,
): CachedCatalogScope | undefined {
  if (!credential) return undefined;
  const kind: CachedCatalogScope["kind"] =
    credential.type === "key" ? "api_key" : "oauth";
  const scope: CachedCatalogScope = { kind };
  if (kind === "oauth" && credential.metadata) {
    const userId = credential.metadata.userId;
    const teamId = credential.metadata.teamId;
    if (typeof userId === "string" && userId) scope.userId = userId;
    if (typeof teamId === "string" && teamId) scope.teamId = teamId;
  }
  return scope;
}

/**
 * The credential scope that produced the current cache, or null when the
 * cache predates the metadata (older release) or cannot be read.
 */
export async function loadCachedScope(
  dir?: string,
): Promise<CachedCatalogScope | null> {
  const file = cachePath(dir);
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const fileData = parsed as CachedModelsFile;
    if (fileData.version !== CACHE_SCHEMA_VERSION) return null;
    const credential = fileData.credential;
    if (!credential || typeof credential !== "object") return null;
    if (credential.kind !== "oauth" && credential.kind !== "api_key") {
      return null;
    }
    const scope: CachedCatalogScope = { kind: credential.kind };
    if (typeof credential.userId === "string" && credential.userId) {
      scope.userId = credential.userId;
    }
    if (typeof credential.teamId === "string" && credential.teamId) {
      scope.teamId = credential.teamId;
    }
    return scope;
  } catch {
    return null;
  }
}

/**
 * Human-readable fetch-scope line for the status/models tools. Unknown when
 * the cache predates the scope metadata.
 */
export function catalogScopeLine(scope: CachedCatalogScope | null): string {
  if (!scope) return "Catalog scope: unknown (cache predates scope metadata)";
  if (scope.kind === "api_key") return "Catalog scope: API key";
  const team = scope.teamId ? ` (team ${scope.teamId})` : " (no team)";
  return `Catalog scope: OAuth session${team}`;
}

/**
 * The oc/*-only + team-bound hint (pi #48): a session inherits its
 * consent-chosen team's model list, so a restricted team hides local and
 * premium models. Only shown when the user can actually fix it by re-login.
 */
export function catalogScopeHint(
  modelIds: string[],
  scope: CachedCatalogScope | null,
): string | undefined {
  if (!scope?.teamId) return undefined;
  if (modelIds.length > 0 && modelIds.every((id) => id.startsWith("oc/"))) {
    return (
      "Only oc/* models are visible (session team scope). If you expect " +
      "local or premium models, /login again and choose a team with that access."
    );
  }
  return undefined;
}

export async function computeCacheAge(dir?: string): Promise<number | null> {
  const file = cachePath(dir);
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const fileData = parsed as CachedModelsFile;
    if (fileData.version !== CACHE_SCHEMA_VERSION) {
      return null;
    }
    if (!Number.isFinite(fileData.fetchedAt)) {
      return null;
    }
    return Math.max(0, Date.now() - fileData.fetchedAt);
  } catch {
    return null;
  }
}

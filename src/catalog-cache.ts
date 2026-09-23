import path from "node:path";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { renameSync } from "node:fs";
import os from "node:os";

const CACHE_SCHEMA_VERSION = 1;
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
  };
  variants?: Record<string, { reasoningEffort: string }>;
}

interface CachedModelsFile {
  version: number;
  fetchedAt: number;
  models: Record<string, OpencodeModelConfig>;
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
): Promise<void> {
  const file = cachePath(dir);
  await mkdir(path.dirname(file), { recursive: true });
  const tmpFile = `${file}.tmp.${process.pid}`;

  const toWrite: CachedModelsFile = {
    version: CACHE_SCHEMA_VERSION,
    fetchedAt: Date.now(),
    models,
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

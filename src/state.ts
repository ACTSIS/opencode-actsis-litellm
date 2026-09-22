import path from "node:path";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { renameSync } from "node:fs";
import os from "node:os";

const STATE_SCHEMA_VERSION = 1;
const DEFAULT_APP_DIR_NAME = "opencode";
const DEFAULT_PLUGIN_DIR_NAME = "actsis-litellm";
const STATE_FILE_NAME = "state.json";

export interface PluginState {
  version: number;
  gatewayUrl?: string;
  providerId?: string;
  authMode?: "oauth" | "api_key";
  clientId?: string;
  tokenEndpoint?: string;
  revocationEndpoint?: string;
  resource?: string;
  schemeUpgraded?: boolean;
  savedAt?: number;
}

function defaultPluginDir(): string {
  const dataHome = process.env.XDG_DATA_HOME
    ? process.env.XDG_DATA_HOME
    : path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, DEFAULT_APP_DIR_NAME, DEFAULT_PLUGIN_DIR_NAME);
}

function statePath(dir?: string): string {
  return path.join(dir ?? defaultPluginDir(), STATE_FILE_NAME);
}

export async function readPluginState(dir?: string): Promise<PluginState | null> {
  const file = statePath(dir);
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const state = parsed as PluginState;
    if (state.version !== STATE_SCHEMA_VERSION) {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

export async function writePluginState(
  state: PluginState,
  dir?: string,
): Promise<void> {
  const file = statePath(dir);
  await mkdir(path.dirname(file), { recursive: true });
  const tmpFile = `${file}.tmp.${process.pid}`;
  try {
    const toWrite: PluginState = {
      ...state,
      version: STATE_SCHEMA_VERSION,
    };
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

export async function updatePluginState(
  patch: Partial<PluginState>,
  dir?: string,
): Promise<PluginState> {
  const current = (await readPluginState(dir)) ?? {
    version: STATE_SCHEMA_VERSION,
  };
  const next: PluginState = {
    ...current,
    ...patch,
    version: STATE_SCHEMA_VERSION,
    savedAt: Date.now(),
  };
  await writePluginState(next, dir);
  return next;
}

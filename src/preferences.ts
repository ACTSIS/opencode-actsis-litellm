import path from "node:path";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { renameSync } from "node:fs";
import os from "node:os";

const PREFS_SCHEMA_VERSION = 1;
const DEFAULT_APP_DIR_NAME = "opencode";
const DEFAULT_PLUGIN_DIR_NAME = "actsis-litellm";
const PREFS_FILE_NAME = "preferences.json";

/**
 * Plugin-owned user preferences. Versioned like the plugin state file so a
 * future schema change can invalidate old content cleanly.
 */
export interface Preferences {
  version: number;
  /** Render the top-5 spend models under the budget widget (default on). */
  topModelsWidget: boolean;
}

export function defaultPreferences(): Preferences {
  return { version: PREFS_SCHEMA_VERSION, topModelsWidget: true };
}

function defaultPluginDir(): string {
  const dataHome = process.env.XDG_DATA_HOME
    ? process.env.XDG_DATA_HOME
    : path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, DEFAULT_APP_DIR_NAME, DEFAULT_PLUGIN_DIR_NAME);
}

function preferencesPath(dir?: string): string {
  return path.join(dir ?? defaultPluginDir(), PREFS_FILE_NAME);
}

/**
 * Reads the persisted preferences. Missing, corrupt, or stale-versioned files
 * fall back to defaults so a broken preference file can never break a command
 * or the widget refresh.
 */
export async function readPreferences(dir?: string): Promise<Preferences> {
  try {
    const raw = await readFile(preferencesPath(dir), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return defaultPreferences();
    }
    const version = typeof parsed.version === "number" ? parsed.version : PREFS_SCHEMA_VERSION;
    if (version !== PREFS_SCHEMA_VERSION) {
      return defaultPreferences();
    }
    return {
      version: PREFS_SCHEMA_VERSION,
      topModelsWidget:
        typeof parsed.topModelsWidget === "boolean"
          ? parsed.topModelsWidget
          : defaultPreferences().topModelsWidget,
    };
  } catch {
    // Missing or corrupt prefs fall back to defaults; never fail a command
    // because of a preference file.
    return defaultPreferences();
  }
}

export function readTopModelsWidgetEnabled(dir?: string): Promise<boolean> {
  return readPreferences(dir).then((prefs) => prefs.topModelsWidget);
}

/**
 * Persists preferences atomically (tmp file + rename, like the plugin state
 * and model cache). Best-effort: an unwritable HOME still allows a
 * session-scoped toggle, so write failures resolve normally.
 */
export async function updateTopModelsWidgetEnabled(
  enabled: boolean,
  dir?: string,
): Promise<void> {
  try {
    await writePreferences(
      { ...defaultPreferences(), ...(await readPreferences(dir)), topModelsWidget: enabled },
      dir,
    );
  } catch {
    // Preference persistence is best-effort.
  }
}

export async function writePreferences(
  prefs: Preferences,
  dir?: string,
): Promise<void> {
  const file = preferencesPath(dir);
  await mkdir(path.dirname(file), { recursive: true });
  const tmpFile = `${file}.tmp.${process.pid}`;
  try {
    const toWrite: Preferences = {
      ...prefs,
      version: PREFS_SCHEMA_VERSION,
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
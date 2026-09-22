import { access, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface OAuthAuthJsonEntry {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
}

export interface ApiAuthJsonEntry {
  type: "api";
  key: string;
}

export type AuthJsonEntry = OAuthAuthJsonEntry | ApiAuthJsonEntry;

export function defaultAuthPath(): string {
  const dataHome = process.env.XDG_DATA_HOME
    ? process.env.XDG_DATA_HOME
    : path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "opencode", "auth.json");
}

export async function readAuthEntry(
  authPath: string = defaultAuthPath(),
  providerId: string,
): Promise<AuthJsonEntry | null> {
  let raw: string;
  try {
    raw = await readFile(authPath, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const entry = record[providerId];
  if (typeof entry !== "object" || entry === null) {
    return null;
  }

  const typed = entry as Partial<AuthJsonEntry>;
  if (typed.type === "oauth") {
    const oauth = entry as Partial<OAuthAuthJsonEntry>;
    if (
      typeof oauth.access === "string" &&
      typeof oauth.refresh === "string" &&
      typeof oauth.expires === "number"
    ) {
      return oauth as OAuthAuthJsonEntry;
    }
  }

  if (typed.type === "api") {
    const api = entry as Partial<ApiAuthJsonEntry>;
    if (typeof api.key === "string") {
      return api as ApiAuthJsonEntry;
    }
  }

  return null;
}

export async function clearAuthEntry(
  authPath: string = defaultAuthPath(),
  providerId: string,
): Promise<void> {
  try {
    await access(authPath);
  } catch {
    return;
  }

  let parsed: unknown;
  try {
    const raw = await readFile(authPath, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    return;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return;
  }

  const record = parsed as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, providerId)) {
    return;
  }

  delete record[providerId];

  await writeFile(authPath, JSON.stringify(record, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

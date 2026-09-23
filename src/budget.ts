import { AuthError, CatalogError } from "./errors.ts";

export interface BudgetInfo {
  spend: number | null;
  maxBudget: number | null;
  tpmLimit: number | null;
  rpmLimit: number | null;
  budgetResetAt: number | null;
  keyAlias: string | null;
}

interface KeyInfoResponse {
  spend?: unknown;
  max_budget?: unknown;
  tpm_limit?: unknown;
  rpm_limit?: unknown;
  budget_reset_at?: unknown;
  key_alias?: unknown;
  info?: KeyInfoResponse;
}

interface UserInfoResponse {
  user_id?: unknown;
  user_alias?: unknown;
  user_info?: KeyInfoResponse;
}

export interface GatewayBudgetSnapshot {
  primary: BudgetInfo;
  ownKeys: BudgetInfo[];
  source: "key_info" | "user_info";
}

function parseBudgetResetAt(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") {
    // Accept epoch seconds or milliseconds for the next ~1000 years.
    if (value < 1_000_000_000_000) {
      return value * 1000;
    }
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function asNullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function parseBudgetRecord(record: KeyInfoResponse): BudgetInfo {
  return {
    spend: asNullableNumber(record.spend),
    maxBudget: asNullableNumber(record.max_budget),
    tpmLimit: asNullableNumber(record.tpm_limit),
    rpmLimit: asNullableNumber(record.rpm_limit),
    budgetResetAt: parseBudgetResetAt(record.budget_reset_at),
    keyAlias: asNullableString(record.key_alias),
  };
}

async function requestJson(
  url: string,
  apiKey: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  label: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new CatalogError(
      `Failed to fetch ${label}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new AuthError("Credential rejected by gateway. Run /login again.");
  }

  if (!response.ok) {
    throw new CatalogError(
      `Failed to fetch ${label}: ${response.status}: ${response.statusText}`,
    );
  }

  try {
    return await response.json();
  } catch (err) {
    throw new CatalogError(
      `${label} response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

export async function fetchBudgetInfo(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<BudgetInfo> {
  const normalized = baseUrl.replace(/\/+$/, "");
  const body = await requestJson(
    `${normalized}/key/info`,
    apiKey,
    timeoutMs,
    fetchImpl,
    "budget info",
  );
  const record = asRecord(body) as KeyInfoResponse;
  const target = record.info ? record.info : record;
  return parseBudgetRecord(target);
}

async function fetchUserBudget(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<{ budget: BudgetInfo; userId: string | null; userAlias: string | null }> {
  const normalized = baseUrl.replace(/\/+$/, "");
  const body = await requestJson(
    `${normalized}/user/info`,
    apiKey,
    timeoutMs,
    fetchImpl,
    "user info",
  );
  const record = asRecord(body) as UserInfoResponse;
  const target = record.user_info
    ? record.user_info
    : (record as unknown as KeyInfoResponse);
  return {
    budget: parseBudgetRecord(target),
    userId: asNullableString(record.user_id),
    userAlias:
      asNullableString(target.key_alias) ?? asNullableString(record.user_alias),
  };
}

async function fetchOwnKeyBudgets(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  filter: { userId: string | null; userAlias: string | null },
): Promise<BudgetInfo[]> {
  if (!filter.userId && !filter.userAlias) {
    return [];
  }

  const normalized = baseUrl.replace(/\/+$/, "");
  const body = await requestJson(
    `${normalized}/spend/keys`,
    apiKey,
    timeoutMs,
    fetchImpl,
    "spend keys",
  );
  if (!Array.isArray(body)) {
    throw new CatalogError("Spend keys response is not an array");
  }

  return body
    .map(asRecord)
    .filter((entry) => {
      if (filter.userId) {
        return entry.user_id === filter.userId;
      }
      return entry.key_alias === filter.userAlias;
    })
    .map((entry) => parseBudgetRecord(entry));
}

export async function fetchGatewayBudget(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<GatewayBudgetSnapshot> {
  try {
    const keyBudget = await fetchBudgetInfo(baseUrl, apiKey, timeoutMs, fetchImpl);
    return { primary: keyBudget, ownKeys: [keyBudget], source: "key_info" };
  } catch (err) {
    if (err instanceof AuthError) {
      throw err;
    }
  }

  const userBudget = await fetchUserBudget(baseUrl, apiKey, timeoutMs, fetchImpl);
  let ownKeys: BudgetInfo[] = [];
  try {
    ownKeys = await fetchOwnKeyBudgets(baseUrl, apiKey, timeoutMs, fetchImpl, {
      userId: userBudget.userId,
      userAlias: userBudget.userAlias,
    });
  } catch {
    // User-level budget remains useful when supplemental key detail fails.
  }

  return { primary: userBudget.budget, ownKeys, source: "user_info" };
}

export function budgetUsagePercent(
  spend: number | null,
  maxBudget: number | null,
): number {
  if (maxBudget === null || maxBudget <= 0) return 0;
  return ((spend ?? 0) / maxBudget) * 100;
}

export function formatBudgetLine(info: BudgetInfo): string | null {
  if (info.spend === null) return null;
  const percent = budgetUsagePercent(info.spend, info.maxBudget);
  const capPart =
    info.maxBudget !== null
      ? ` / $${info.maxBudget.toFixed(2)} used (${Math.round(percent)}%)`
      : ` used (no budget cap)`;
  let line = `$${info.spend.toFixed(2)}${capPart}`;
  if (info.tpmLimit !== null) {
    line += ` | TPM ${info.tpmLimit.toLocaleString("en-US")}`;
  }
  if (info.rpmLimit !== null) {
    line += ` | RPM ${info.rpmLimit.toLocaleString("en-US")}`;
  }
  if (info.budgetResetAt !== null) {
    const time = new Date(info.budgetResetAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    line += ` | resets ${time}`;
  }
  return line;
}

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatBudgetStatus, type GatewayBudgetSnapshot } from "./budget.ts";

export interface BudgetWidgetData {
  snapshot?: GatewayBudgetSnapshot;
  refreshedAt?: number;
}

/**
 * Compute the budget line rendered by the TUI widget.
 *
 * Returns null whenever there is nothing trustworthy to display: no snapshot,
 * a missing or non-finite refresh timestamp, or a snapshot older than
 * `maxAgeSeconds` (when provided).
 */
export function budgetWidgetLine(
  data: BudgetWidgetData,
  now: number,
  maxAgeSeconds?: number,
): string | null {
  if (!data.snapshot) return null;
  if (typeof data.refreshedAt !== "number" || !Number.isFinite(data.refreshedAt)) {
    return null;
  }
  if (
    maxAgeSeconds !== undefined &&
    (now - data.refreshedAt) / 1000 > maxAgeSeconds
  ) {
    return null;
  }

  const status = formatBudgetStatus(data.snapshot.primary);
  if (status !== undefined) return status;
  return "Budget: no spend data";
}

function defaultStateDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return path.join(xdg, "opencode");
  return path.join(os.homedir(), ".local", "share", "opencode");
}

/**
 * Read the persisted budget snapshot written by the server plugin
 * (`<state-dir>/actsis-litellm/state.json`). Returns null for any missing,
 * malformed, or incomplete state file.
 */
export async function readBudgetWidgetData(
  dir?: string,
): Promise<BudgetWidgetData | null> {
  const base = dir ?? defaultStateDir();
  const file = path.join(base, "actsis-litellm", "state.json");

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const snapshot = record.lastBudgetSnapshot as
    | GatewayBudgetSnapshot
    | undefined;
  if (typeof snapshot !== "object" || snapshot === null) return null;
  if (typeof snapshot.primary !== "object" || snapshot.primary === null) {
    return null;
  }

  const refreshedAt = record.budgetRefreshedAt;
  return {
    snapshot,
    refreshedAt:
      typeof refreshedAt === "number" && Number.isFinite(refreshedAt)
        ? refreshedAt
        : undefined,
  };
}
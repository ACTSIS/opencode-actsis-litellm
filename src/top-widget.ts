import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { budgetGauge } from "./budget.ts";
import type { TopModelRow } from "./state.ts";
import {
  applyModelAliases,
  mapModelAliases,
  type ModelUsageSummary,
} from "./usage.ts";

/**
 * Top-5 spend widget: the compact per-model breakdown shown under the budget
 * line in the TUI. Data is fetched by the server plugin (same triggers as the
 * budget snapshot) and persisted in the plugin state, so the TUI plugin only
 * ever reads state.json — the same flow the budget widget uses.
 */

export const TOP_MODELS_ROW_LIMIT = 5;
export const TOP_MODELS_WINDOW_DAYS = 7;
export const TOP_WIDGET_WINDOW_LABEL = "7d";
/** Gateway data TTL: a top refresh inside the window is skipped. */
export const TOP_MODELS_TTL_MS = 5 * 60 * 1000;

/** One persisted top-model spend row lives in state.ts. */
export type { TopModelRow };

/** Persisted top-5 data as consumed by the TUI widget. */
export interface TopWidgetData {
  rows: TopModelRow[];
  windowLabel: string;
  totalSpend: number;
  refreshedAt: number;
}

/**
 * Converts runs of 2+ ASCII spaces into NBSP runs: terminal sanitizers
 * collapse ASCII space runs but preserve NBSP, so column padding survives
 * into the rendered widget with identical width.
 */
export function nbspRuns(text: string): string {
  return text.replace(/ {2,}/g, (run) => "\u00a0".repeat(run.length));
}

/** Budget-style 8-cell gauge over a [0,100] percentage (▰ filled / ▱ empty). */
export function usageGauge(percent: number): string {
  return budgetGauge(Number.isFinite(percent) ? percent : 0);
}

const WIDGET_PCT_WIDTH = 3;
const WIDGET_NAME_WIDTH = 26;
const WIDGET_SPEND_MIN_WIDTH = "$0.00".length;

/**
 * Formats the widget block as display lines: title, "=" separator, then the
 * model rows with the model name left-aligned, the spend right-aligned, the
 * share of the window total right-aligned, and an 8-cell share gauge.
 * Rows are padded with NBSP so alignment survives sanitizers that collapse
 * ASCII spaces (port of pi c03385b).
 */
export function buildTopModelsWidgetLines(options: {
  windowLabel: string;
  rows: TopModelRow[];
  totalSpend?: number | null;
  maxRows?: number;
  maxNameWidth?: number;
}): string[] {
  const maxRows = options.maxRows ?? TOP_MODELS_ROW_LIMIT;
  const maxNameWidth = options.maxNameWidth ?? WIDGET_NAME_WIDTH;

  const rows = options.rows.slice(0, maxRows).map((row) => ({
    model:
      row.model.length > maxNameWidth
        ? `${row.model.slice(0, maxNameWidth - 1)}…`
        : row.model,
    spend: row.spend,
  }));
  if (rows.length === 0) return [];

  // Share percentages are relative to the window total: the sum of the rows
  // themselves when the caller has no authoritative total.
  const windowTotal = totalSpendOf(options.totalSpend, rows);

  const titleSpendPart =
    options.totalSpend !== null && options.totalSpend !== undefined
      ? ` · $${options.totalSpend.toFixed(2)}`
      : "";

  const nameWidth = Math.max(0, ...rows.map((r) => r.model.length));
  const spendWidth = Math.max(
    WIDGET_SPEND_MIN_WIDTH,
    ...rows.map((r) => `$${r.spend.toFixed(2)}`.length),
  );
  const tableWidth =
    nameWidth + 1 + spendWidth + 1 + WIDGET_PCT_WIDTH + 1 + 1 + 8;

  const lines: string[] = [
    `Top models (${options.windowLabel})${titleSpendPart}`,
  ];
  // "=" rule under the title, spanning the full rendered row width (the %
  // sign and the space before the gauge count as cells).
  lines.push("=".repeat(tableWidth));
  for (const row of rows) {
    const share =
      windowTotal > 0
        ? Math.min(100, Math.max(0, (row.spend / windowTotal) * 100))
        : 0;
    const raw = `${row.model.padEnd(nameWidth)} ${`$${row.spend.toFixed(2)}`.padStart(spendWidth)} ${String(Math.round(share)).padStart(WIDGET_PCT_WIDTH)}% ${usageGauge(share)}`;
    lines.push(nbspRuns(raw));
  }
  return lines;
}

function totalSpendOf(
  totalSpend: number | null | undefined,
  rows: Array<{ spend: number }>,
): number {
  return totalSpend !== null && totalSpend !== undefined
    ? totalSpend
    : rows.reduce((sum, r) => sum + r.spend, 0);
}

/**
 * Renders the top block (uses the window total over the rows when data is
 * valid), or null when there is nothing trustworthy: no rows, a missing or
 * non-finite refresh timestamp, or data older than `maxAgeSeconds`.
 */
export function topWidgetLines(
  data: TopWidgetData,
  now: number,
  maxAgeSeconds?: number,
): string[] | null {
  if (!data.rows || data.rows.length === 0) return null;
  if (!Number.isFinite(data.refreshedAt)) return null;
  if (
    maxAgeSeconds !== undefined &&
    (now - data.refreshedAt) / 1000 > maxAgeSeconds
  ) {
    return null;
  }
  return buildTopModelsWidgetLines({
    windowLabel: data.windowLabel,
    rows: data.rows,
    totalSpend: data.totalSpend,
  });
}

function defaultStateDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return path.join(xdg, "opencode");
  return path.join(os.homedir(), ".local", "share", "opencode");
}

function rowFromUnknown(value: unknown): TopModelRow | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.model !== "string" || !record.model) return null;
  if (typeof record.spend !== "number" || !Number.isFinite(record.spend)) {
    return null;
  }
  return { model: record.model, spend: record.spend };
}

function rowsFromUnknown(value: unknown): TopModelRow[] | null {
  if (typeof value !== "object" || value === null || !Array.isArray(value)) {
    return null;
  }
  const rows: TopModelRow[] = [];
  for (const entry of value) {
    const row = rowFromUnknown(entry);
    if (!row) return null;
    rows.push(row);
  }
  return rows;
}

/**
 * Reads the persisted top-5 data written by the server plugin
 * (`<state-dir>/actsis-litellm/state.json`). Returns null for any missing,
 * malformed, or empty data.
 */
export async function readTopWidgetData(
  dir?: string,
): Promise<TopWidgetData | null> {
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
  const rows = rowsFromUnknown(record.lastTopModels);
  if (!rows || rows.length === 0) return null;
  const refreshedAt = record.topRefreshedAt;
  if (typeof refreshedAt !== "number" || !Number.isFinite(refreshedAt)) {
    return null;
  }
  const windowLabel =
    typeof record.topWindowLabel === "string" && record.topWindowLabel
      ? record.topWindowLabel
      : TOP_WIDGET_WINDOW_LABEL;
  const totalSpend =
    typeof record.topTotalSpend === "number" && Number.isFinite(record.topTotalSpend)
      ? record.topTotalSpend
      : rows.reduce((sum, r) => sum + r.spend, 0);
  return { rows, windowLabel, totalSpend, refreshedAt };
}

/**
 * Applies the public-alias mapping (the same one the /usage command shows)
 * and selects the top `TOP_MODELS_ROW_LIMIT` spend rows for the widget,
 * together with the alias-merged window total.
 */
export function computeTopModelRows(
  summary: ModelUsageSummary,
  publicIds: string[],
): { rows: TopModelRow[]; totalSpend: number } {
  const display = applyModelAliases(
    summary,
    mapModelAliases(
      summary.models.map((m) => m.model),
      publicIds,
    ),
  );
  return {
    rows: display.models
      .slice(0, TOP_MODELS_ROW_LIMIT)
      .map((m) => ({ model: m.model, spend: m.spend ?? 0 })),
    totalSpend: display.totals.spend ?? 0,
  };
}
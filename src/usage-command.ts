import { isoDay, resolveDefaultUsageRange, type UsageRange } from "./usage.ts";

/**
 * Window parsing for the /actsis-litellm:usage command and the
 * actsis_litellm_usage tool. Mirrors the sibling pi extension's
 * commands.ts: default = last 30 days inclusive (UTC), day counts clamp
 * to >= 1, and explicit ranges accept `to`, `..`, `,`, and `→` separators.
 */
const RANGE_ARG_RE = /^(\d{4}-\d{2}-\d{2})\s+(?:to|→|\.\.|,)\s+(\d{4}-\d{2}-\d{2})$/;

export interface ParsedUsageRangeArg {
  range: UsageRange;
  label: string;
}

/**
 * Parses the usage window argument. Supported forms:
 *   (empty)            -> default range (last 30 days inclusive)
 *   7 | 14 | 30        -> last N days inclusive (clamped to >= 1)
 *   2025-03-01 .. 2025-03-31 (separators: to, .., comma, arrow)
 */
export function parseUsageRangeArg(
  args: string | undefined | null,
  nowMs?: number,
): ParsedUsageRangeArg | { error: string } {
  const trimmed = (args ?? "").trim();
  const now = typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : Date.now();
  const defaults = resolveDefaultUsageRange(now);
  if (!trimmed) {
    return { range: defaults, label: "last 30 days" };
  }
  if (/^\d+$/.test(trimmed)) {
    const days = Math.max(1, parseInt(trimmed, 10));
    const end = isoDay(now);
    const start = isoDay(now - (days - 1) * 24 * 60 * 60 * 1000);
    return {
      range: { startDate: start, endDate: end },
      label: `last ${days} day${days === 1 ? "" : "s"}`,
    };
  }
  const rangeMatch = trimmed.match(RANGE_ARG_RE);
  if (rangeMatch) {
    const [, start, end] = rangeMatch;
    if (Date.parse(`${start}T00:00:00Z`) > Date.parse(`${end}T00:00:00Z`)) {
      return { error: `start date ${start} is after end date ${end}` };
    }
    return { range: { startDate: start, endDate: end }, label: `${start} → ${end}` };
  }
  return {
    error:
      "expected nothing (last 30 days), a day count like `14`, or a range like `2025-03-01 .. 2025-03-31`",
  };
}
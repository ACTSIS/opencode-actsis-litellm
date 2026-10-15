import assert from "node:assert/strict";
import { afterEach, it, vi } from "vitest";
import { formatBudgetLine } from "../src/budget.ts";
import { formatThrottleWarning } from "../src/limit-errors.ts";
import { formatUsageSubsLines, type UsageSubscriptions } from "../src/usage-subs.ts";
import { formatUsageLines, formatUsageTable, resolveUsageRangeDays } from "../src/usage.ts";
import { buildTopModelsWidgetLines } from "../src/top-widget.ts";

const window = {
  usageUsd: null, limitUsd: null, requests: 7,
  inputTokens: 10, outputTokens: 20, from: null, until: null,
};
function subscriptions(sessionReset: string | null, weeklyReset: string | null): UsageSubscriptions {
  return {
    generatedAt: null,
    subscriptions: [{
      name: "countdown", plan: null, session5h: window, weekly: window,
      credits: {
        includedUsd: null, includedBalanceUsd: null, purchasedUsd: 2,
        session: { remainingPercent: 80, resetsAt: sessionReset },
        weekly: { remainingPercent: 70, resetsAt: weeklyReset },
      },
      error: null,
    }],
  };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("shows absolute timestamps in the system zone across date rollovers and DST", () => {
  const cases = [
    ["America/Bogota", "2026-10-14T03:30:00Z", "2026-10-13 22:30 (America/Bogota, GMT-05:00)"],
    ["Asia/Tokyo", "2026-10-14T22:30:00Z", "2026-10-15 07:30 (Asia/Tokyo, GMT+09:00)"],
    ["America/New_York", "2026-03-08T06:30:00Z", "2026-03-08 01:30 (America/New_York, GMT-05:00)"],
    ["America/New_York", "2026-03-08T07:30:00Z", "2026-03-08 03:30 (America/New_York, GMT-04:00)"],
    ["UTC", "2026-10-14T03:30:00Z", "2026-10-14 03:30 (UTC, GMT+00:00)"],
  ];
  for (const [zone, instant, expected] of cases) {
    vi.stubEnv("TZ", zone);
    const reset = Date.parse(instant);
    vi.spyOn(Date, "now").mockReturnValue(reset - 35 * 60_000);
    assert.equal(formatUsageSubsLines({ generatedAt: instant, subscriptions: [] })[0],
      `Usage subscriptions (generated at ${expected}):`);
    assert.equal(formatBudgetLine({
      spend: 50, maxBudget: 100, budgetResetAt: reset,
      tpmLimit: null, rpmLimit: null, keyAlias: null,
    }), `$50.00 / $100.00 used (50%) | resets ${expected}`);
    assert.equal(formatThrottleWarning({
      kind: "throttling_error", limitType: "tokens", resetsAt: reset, raw: "",
    }), `Rate limit reached (tokens). Resets at ${expected} (~35 min). OpenCode will retry automatically.`);
    vi.restoreAllMocks();
  }
});

it("keeps unavailable generation timestamps unavailable", () => {
  for (const generatedAt of [null, "not-a-date"]) {
    assert.deepEqual(formatUsageSubsLines({ generatedAt, subscriptions: [] }), [
      "Usage subscriptions (generated at -):", "(no subscriptions returned)",
    ]);
  }
});

it("matches Pi countdown units, rounding, expired and unavailable resets in every zone", () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-14T12:00:00Z"));
  for (const zone of ["America/Bogota", "Asia/Tokyo"]) {
    vi.stubEnv("TZ", zone);
    for (const [session, weekly, sessionText, weeklyText] of [
      ["2026-10-14T14:35:00Z", "2026-10-17T20:00:00Z", "2 h 35 min", "3 d 8 h"],
      ["2026-10-14T12:00:01Z", "2026-10-14T12:00:01Z", "0 h 1 min", "0 d 1 h"],
      ["2026-10-14T12:59:01Z", "2026-10-15T11:59:01Z", "1 h 0 min", "1 d 0 h"],
      ["2026-10-14T12:00:00Z", "2026-10-13T12:00:00Z", "0 h 0 min", "0 d 0 h"],
      [null, "invalid", "-", "-"],
    ]) {
      const lines = formatUsageSubsLines(subscriptions(session, weekly));
      assert.deepEqual(lines[1].split(/\s{2,}/), [
        "Sub", "5h used", "5h resets in", "Weekly used", "Weekly resets in", "Credits",
      ]);
      assert.deepEqual(lines[3].split(/\s{2,}/), [
        "countdown", "▰▰▱▱▱▱▱▱ 20% 7 reqs", sessionText,
        "▰▰▱▱▱▱▱▱ 30% 7 reqs", weeklyText, "purchased $2.00",
      ]);
    }
  }
});

it("labels UTC query days without changing query dates or totals", () => {
  for (const zone of ["America/Bogota", "Asia/Tokyo"]) {
    vi.stubEnv("TZ", zone);
    const range = resolveUsageRangeDays(7, Date.parse("2026-10-14T01:00:00Z"));
    assert.deepEqual(range, { startDate: "2026-10-08", endDate: "2026-10-14" });
    const summary = {
      ...range, totals: { spend: 2, totalTokens: 30, apiRequests: 4, promptTokens: 10, completionTokens: 20 }, models: [],
    };
    assert.equal(formatUsageTable(summary)[0], "Usage 2026-10-08 → 2026-10-14 (7 UTC days): $2.0000");
    assert.equal(formatUsageLines(summary)[0], "Usage 2026-10-08 → 2026-10-14 (7 UTC days): spend $2.0000, 30 tokens, 4 requests");
    assert.equal(buildTopModelsWidgetLines({ windowLabel: "7d", rows: [{ model: "m", spend: 2 }] })[0], "Top models (7d, UTC days)");
  }
});

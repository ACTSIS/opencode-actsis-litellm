import { describe, expect, it, vi } from "vitest";
import {
  fetchBudgetInfo,
  formatBudgetLine,
  budgetUsagePercent,
} from "../src/budget.ts";
import { AuthError, CatalogError } from "../src/errors.ts";

describe("parseBudgetResetAt via fetchBudgetInfo", () => {
  it("parses epoch seconds into milliseconds", async () => {
    const tsSeconds = 1_700_000_000;
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({ spend: 1, max_budget: 10, budget_reset_at: tsSeconds }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const info = await fetchBudgetInfo("https://gw.example", "sk-test", 5000, fetchImpl);
    expect(info.budgetResetAt).toBe(tsSeconds * 1000);
  });

  it("parses epoch milliseconds as-is", async () => {
    const tsMs = 1_700_000_000_000;
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({ spend: 1, max_budget: 10, budget_reset_at: tsMs }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const info = await fetchBudgetInfo("https://gw.example", "sk-test", 5000, fetchImpl);
    expect(info.budgetResetAt).toBe(tsMs);
  });

  it("parses ISO strings", async () => {
    const iso = "2026-12-25T12:00:00.000Z";
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({ spend: 1, max_budget: 10, budget_reset_at: iso }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const info = await fetchBudgetInfo("https://gw.example", "sk-test", 5000, fetchImpl);
    expect(info.budgetResetAt).toBe(Date.parse(iso));
  });
});

describe("fetchBudgetInfo", () => {
  it("maps key info fields", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          spend: 12.34,
          max_budget: 100,
          tpm_limit: 5000,
          rpm_limit: 1000,
          key_alias: "prod-key",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const info = await fetchBudgetInfo("https://gw.example", "sk-test", 5000, fetchImpl);
    expect(info).toEqual({
      spend: 12.34,
      maxBudget: 100,
      tpmLimit: 5000,
      rpmLimit: 1000,
      budgetResetAt: null,
      keyAlias: "prod-key",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://gw.example/key/info",
      expect.objectContaining({
        headers: { Authorization: "Bearer sk-test" },
      }),
    );
  });

  it("throws AuthError on 401", async () => {
    const fetchImpl = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    await expect(
      fetchBudgetInfo("https://gw.example", "sk-test", 5000, fetchImpl),
    ).rejects.toThrow(AuthError);
  });

  it("throws AuthError on 403", async () => {
    const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 }));
    await expect(
      fetchBudgetInfo("https://gw.example", "sk-test", 5000, fetchImpl),
    ).rejects.toThrow(AuthError);
  });

  it("throws CatalogError on non-2xx", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad gateway", { status: 502 }));
    await expect(
      fetchBudgetInfo("https://gw.example", "sk-test", 5000, fetchImpl),
    ).rejects.toThrow(CatalogError);
  });
});

describe("budgetUsagePercent", () => {
  it("returns the spend/max ratio times 100", () => {
    expect(budgetUsagePercent(25, 100)).toBe(25);
    expect(budgetUsagePercent(0, 100)).toBe(0);
    expect(budgetUsagePercent(100, 100)).toBe(100);
  });

  it("returns 0 when max is null, zero, or negative", () => {
    expect(budgetUsagePercent(50, null)).toBe(0);
    expect(budgetUsagePercent(50, 0)).toBe(0);
    expect(budgetUsagePercent(50, -10)).toBe(0);
  });

  it("treats null spend as 0", () => {
    expect(budgetUsagePercent(null, 100)).toBe(0);
  });
});

describe("formatBudgetLine", () => {
  it("returns null when spend is null", () => {
    expect(
      formatBudgetLine({
        spend: null,
        maxBudget: 100,
        tpmLimit: null,
        rpmLimit: null,
        budgetResetAt: null,
        keyAlias: null,
      }),
    ).toBeNull();
  });

  it("formats spend/cap/percent", () => {
    const line = formatBudgetLine({
      spend: 12.34,
      maxBudget: 100,
      tpmLimit: null,
      rpmLimit: null,
      budgetResetAt: null,
      keyAlias: null,
    });
    expect(line).toBe("$12.34 / $100.00 used (12%)");
  });

  it("formats spend with no cap", () => {
    const line = formatBudgetLine({
      spend: 12.34,
      maxBudget: null,
      tpmLimit: null,
      rpmLimit: null,
      budgetResetAt: null,
      keyAlias: null,
    });
    expect(line).toBe("$12.34 used (no budget cap)");
  });

  it("appends reset time when present", () => {
    const resetAt = new Date("2026-12-25T12:00:00.000Z").getTime();
    const line = formatBudgetLine({
      spend: 12.34,
      maxBudget: 100,
      tpmLimit: null,
      rpmLimit: null,
      budgetResetAt: resetAt,
      keyAlias: null,
    });
    expect(line).toContain("$12.34 / $100.00 used (12%)");
    expect(line).toContain("resets");
  });
});

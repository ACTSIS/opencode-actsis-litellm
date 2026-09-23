import { describe, expect, it, vi } from "vitest";
import {
  fetchBudgetInfo,
  fetchGatewayBudget,
  formatBudgetLine,
  formatBudgetStatus,
  budgetGauge,
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
  it("maps nested key info fields", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          key: "sk-hash",
          info: {
            spend: 12.34,
            max_budget: 100,
            tpm_limit: 5000,
            rpm_limit: 1000,
            key_alias: "prod-key",
          },
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
  });

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

describe("fetchGatewayBudget", () => {
  it("falls back to user info and filters key spend by user id", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/key/info") {
        return new Response("gateway error", { status: 500 });
      }
      if (path === "/user/info") {
        return new Response(
          JSON.stringify({
            user_id: "user-1",
            user_info: {
              spend: 29.9,
              max_budget: null,
              tpm_limit: 2_000_000,
              rpm_limit: 600,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (path === "/spend/keys") {
        return new Response(
          JSON.stringify([
            {
              key_alias: "RPINTO",
              spend: 158.72,
              max_budget: 100,
              tpm_limit: 2_000_000,
              rpm_limit: 600,
              user_id: "user-1",
            },
            {
              key_alias: "OTHER",
              spend: 999,
              max_budget: 1000,
              user_id: "user-2",
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const snapshot = await fetchGatewayBudget(
      "https://gw.example",
      "oauth-token",
      5000,
      fetchImpl,
    );

    expect(snapshot.source).toBe("user_info");
    expect(snapshot.primary).toMatchObject({
      spend: 29.9,
      maxBudget: null,
      tpmLimit: 2_000_000,
      rpmLimit: 600,
    });
    expect(snapshot.ownKeys).toEqual([
      expect.objectContaining({
        keyAlias: "RPINTO",
        spend: 158.72,
        maxBudget: 100,
      }),
    ]);
  });

  it("never exposes spend keys when the caller cannot be identified", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/key/info") {
        return new Response("gateway error", { status: 500 });
      }
      if (path === "/user/info") {
        return new Response(
          JSON.stringify({ user_info: { spend: 5 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify([{ key_alias: "OTHER", spend: 999, user_id: "user-2" }]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const snapshot = await fetchGatewayBudget(
      "https://gw.example",
      "oauth-token",
      5000,
      fetchImpl,
    );

    expect(snapshot.primary.spend).toBe(5);
    expect(snapshot.ownKeys).toEqual([]);
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

describe("budgetGauge", () => {
  it("renders empty gauge at 0", () => {
    expect(budgetGauge(0)).toBe("▱▱▱▱▱▱▱▱");
  });

  it("renders full gauge at 100", () => {
    expect(budgetGauge(100)).toBe("▰▰▰▰▰▰▰▰");
  });

  it("renders half gauge at 50", () => {
    expect(budgetGauge(50)).toBe("▰▰▰▰▱▱▱▱");
  });

  it("clamps negative percents to an empty gauge", () => {
    expect(budgetGauge(-25)).toBe("▱▱▱▱▱▱▱▱");
  });

  it("clamps over-100 percents to a full gauge", () => {
    expect(budgetGauge(159)).toBe("▰▰▰▰▰▰▰▰");
  });

  it("rounds fractional cell counts", () => {
    // 12.5% * 8 cells = 1 cell
    expect(budgetGauge(12.5)).toBe("▰▱▱▱▱▱▱▱");
    // 90% * 8 cells = 7.2 -> 7 cells
    expect(budgetGauge(90)).toBe("▰▰▰▰▰▰▰▱");
  });
});

describe("formatBudgetStatus", () => {
  it("returns undefined when spend is null", () => {
    expect(
      formatBudgetStatus({
        spend: null,
        maxBudget: 100,
        tpmLimit: null,
        rpmLimit: null,
        budgetResetAt: null,
        keyAlias: null,
      }),
    ).toBeUndefined();
  });

  it("formats capped spend with gauge and percent", () => {
    expect(
      formatBudgetStatus({
        spend: 12.34,
        maxBudget: 100,
        tpmLimit: null,
        rpmLimit: null,
        budgetResetAt: null,
        keyAlias: null,
      }),
    ).toBe("Budget ▰▱▱▱▱▱▱▱ 12% · $12.34/$100.00");
  });

  it("formats uncapped spend", () => {
    expect(
      formatBudgetStatus({
        spend: 5,
        maxBudget: null,
        tpmLimit: null,
        rpmLimit: null,
        budgetResetAt: null,
        keyAlias: null,
      }),
    ).toBe("Budget $5.00 used (no cap)");
  });

  it("uses the uncapped form when the cap is zero or negative", () => {
    const base = {
      spend: 5,
      tpmLimit: null,
      rpmLimit: null,
      budgetResetAt: null,
      keyAlias: null,
    };
    expect(formatBudgetStatus({ ...base, maxBudget: 0 })).toBe(
      "Budget $5.00 used (no cap)",
    );
    expect(formatBudgetStatus({ ...base, maxBudget: -10 })).toBe(
      "Budget $5.00 used (no cap)",
    );
  });

  it("rounds the percent shown in the string", () => {
    // 15.872/100 = 15.872% -> rounds to 16%; 8 cells * 0.15872 = 1.27 -> 1 cell
    expect(
      formatBudgetStatus({
        spend: 15.872,
        maxBudget: 100,
        tpmLimit: null,
        rpmLimit: null,
        budgetResetAt: null,
        keyAlias: null,
      }),
    ).toBe("Budget ▰▱▱▱▱▱▱▱ 16% · $15.87/$100.00");
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

  it("appends TPM and RPM limits when present", () => {
    const line = formatBudgetLine({
      spend: 12.34,
      maxBudget: 100,
      tpmLimit: 2_000_000,
      rpmLimit: 600,
      budgetResetAt: null,
      keyAlias: null,
    });
    expect(line).toBe(
      "$12.34 / $100.00 used (12%) | TPM 2,000,000 | RPM 600",
    );
  });
});

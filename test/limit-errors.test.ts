import { describe, expect, it } from "vitest";
import {
  extractFirstBalancedJson,
  parseLimitError,
  classify429,
  formatBudgetWarning,
  formatThrottleWarning,
  classifyGatewayError,
  budgetUsagePercent,
} from "../src/limit-errors.ts";

describe("extractFirstBalancedJson", () => {
  it("extracts a simple JSON object", () => {
    expect(extractFirstBalancedJson('prefix {"a":1} suffix')).toBe('{"a":1}');
  });

  it("extracts nested objects", () => {
    expect(extractFirstBalancedJson('x {"a":{"b":1}} y')).toBe('{"a":{"b":1}}');
  });

  it("extracts JSON with string containing braces", () => {
    const text = 'error {"message":"something {unexpected}"}';
    expect(extractFirstBalancedJson(text)).toBe('{"message":"something {unexpected}"}');
  });

  it("extracts arrays", () => {
    expect(extractFirstBalancedJson('x [1,2,3] y')).toBe('[1,2,3]');
  });

  it("handles escaped quotes inside strings", () => {
    expect(extractFirstBalancedJson('x {"a":"say \\"hi\\""} y')).toBe(
      '{"a":"say \\"hi\\""}',
    );
  });

  it("returns null when there is no balanced JSON", () => {
    expect(extractFirstBalancedJson("no json here")).toBeNull();
    expect(extractFirstBalancedJson("{ incomplete")).toBeNull();
  });
});

describe("parseLimitError", () => {
  it("parses budget_exceeded with numbers", () => {
    const info = parseLimitError(
      JSON.stringify({
        type: "budget_exceeded",
        message: "Current cost: 12.34. Max budget: 100.00",
      }),
    );
    expect(info).toEqual({
      kind: "budget_exceeded",
      currentSpend: 12.34,
      maxBudget: 100,
      raw: expect.stringContaining("budget_exceeded"),
    });
  });

  it("parses throttling_error with limit type and reset time", () => {
    const message =
      'Limit type: tpm, Limit resets at: 2026-12-25 12:00:00 UTC';
    const info = parseLimitError(
      JSON.stringify({ type: "throttling_error", message }),
    );
    expect(info?.kind).toBe("throttling_error");
    expect(info?.limitType).toBe("tpm");
    expect(info?.resetsAt).toBe(Date.parse("2026-12-25 12:00:00 UTC"));
  });

  it("returns rate_limit_other for 429 in raw text without structured JSON", () => {
    const info = parseLimitError("rate limit hit: 429");
    expect(info?.kind).toBe("rate_limit_other");
  });

  it("returns rate_limit_other for JSON payload with code 429", () => {
    const info = parseLimitError(
      JSON.stringify({ code: "429", message: "too many" }),
    );
    expect(info?.kind).toBe("rate_limit_other");
  });

  it("returns null for non-429 errors", () => {
    const info = parseLimitError(
      JSON.stringify({ type: "validation_error", message: "bad request" }),
    );
    expect(info).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseLimitError("")).toBeNull();
    expect(parseLimitError(null)).toBeNull();
    expect(parseLimitError(undefined)).toBeNull();
  });
});

describe("classify429", () => {
  it("classifies known limit kinds", () => {
    expect(
      classify429(
        JSON.stringify({
          type: "budget_exceeded",
          message: "Current cost: 1. Max budget: 1.",
        }),
      ),
    ).toBe("budget_exceeded");
    expect(
      classify429(
        JSON.stringify({
          type: "throttling_error",
          message: "Limit type: tpm",
        }),
      ),
    ).toBe("throttling_error");
  });

  it("classifies 429 as rate_limit_other", () => {
    expect(classify429("429")).toBe("rate_limit_other");
  });

  it("returns none for unrelated errors", () => {
    expect(classify429("internal server error")).toBe("none");
  });
});

describe("formatBudgetWarning", () => {
  it("formats budget exceeded warning", () => {
    const warning = formatBudgetWarning({
      kind: "budget_exceeded",
      currentSpend: 12.34,
      maxBudget: 100,
      raw: "",
    });
    expect(warning).toBe(
      "Budget exceeded: $12.34 of $100.00 used — top up the key budget or wait for the reset.",
    );
  });
});

describe("formatThrottleWarning", () => {
  it("includes resets-at local time and minutes remaining", () => {
    const resetsAt = Date.now() + 25 * 60_000;
    const warning = formatThrottleWarning({
      kind: "throttling_error",
      limitType: "tpm",
      resetsAt,
      raw: "",
    });
    expect(warning).toMatch(/^Rate limit reached \(tpm\)\. Resets at /);
    expect(warning).toContain("~25 min");
    expect(warning).toContain("OpenCode will retry automatically");
  });

  it("omits reset details when no reset time is provided", () => {
    const warning = formatThrottleWarning({
      kind: "throttling_error",
      raw: "",
    });
    expect(warning).toBe("Rate limit reached. OpenCode will retry automatically.");
  });
});

describe("classifyGatewayError", () => {
  it("returns classified info for budget exceeded", () => {
    const result = classifyGatewayError(
      JSON.stringify({
        type: "budget_exceeded",
        message: "Current cost: 12.34. Max budget: 100.00",
      }),
    );
    expect(result?.kind).toBe("budget_exceeded");
    expect(result?.info.currentSpend).toBe(12.34);
  });

  it("returns null for unclassified messages", () => {
    expect(classifyGatewayError("internal server error")).toBeNull();
  });
});

describe("budgetUsagePercent re-export", () => {
  it("reuses budgetUsagePercent from budget.ts", () => {
    expect(budgetUsagePercent(50, 100)).toBe(50);
    expect(budgetUsagePercent(null, 100)).toBe(0);
  });
});

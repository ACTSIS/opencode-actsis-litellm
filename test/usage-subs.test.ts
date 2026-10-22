import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  fetchUsageSubs,
  formatUsageSubsLines,
  type UsageSubscriptions,
} from "../src/usage-subs.ts";
import { AuthError, CatalogError } from "../src/errors.ts";
import { buildLitellmToolInfos, type ToolDeps } from "../src/tools.ts";
import { buildCommandDefinitions } from "../src/plugin.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface RecordedCall {
  url: URL;
  request: Request;
}

/**
 * Records fetch calls and delegates to a scenario implementation.
 * fetchUsageSubs uses the global fetch by default, so this stubs globalThis.fetch.
 */
function stubGlobalFetch(
  impl: (call: RecordedCall) => Response | Promise<Response>,
): { calls: RecordedCall[]; restore: () => void } {
  const calls: RecordedCall[] = [];
  const original = globalThis.fetch;
  const stub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const request = new Request(String(input), init);
    const call = { url, request };
    calls.push(call);
    return impl(call);
  }) as unknown as typeof fetch;
  globalThis.fetch = stub;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function sampleBody(): UsageSubscriptions {
  return {
    generatedAt: "2026-10-14T12:00:00Z",
    subscriptions: [
      {
        name: "alpha",
        provider: null,
        account: null,
        status: null,
        plan: "Pro",
        session5h: {
          usageUsd: 5.0,
          limitUsd: 10.0,
          requests: 12,
          inputTokens: 400,
          outputTokens: 800,
          from: "2026-10-14T07:00:00Z",
          until: "2026-10-14T12:00:00Z",
        },
        weekly: {
          usageUsd: 20.0,
          limitUsd: 50.0,
          requests: 120,
          inputTokens: 5000,
          outputTokens: 10000,
          from: null,
          until: null,
        },
        credits: {
          includedUsd: 100.0,
          includedBalanceUsd: 80.0,
          purchasedUsd: 20.0,
          session: null,
          weekly: null,
        },
        error: null,
      },
    ],
  };
}

describe("fetchUsageSubs", () => {
  it("GETs /subs-usage once with Bearer auth", async () => {
    const { calls, restore } = stubGlobalFetch((call) => {
      expect(call.url.pathname).toBe("/subs-usage");
      return jsonResponse(sampleBody());
    });
    try {
      const result = await fetchUsageSubs("http://gw.example:4000", "sk-test", 5_000);
      expect(calls.length).toBe(1);
      expect(calls[0].url.toString()).toBe("http://gw.example:4000/subs-usage");
      expect(calls[0].request.headers.get("authorization")).toBe("Bearer sk-test");
      expect(result.generatedAt).toBe("2026-10-14T12:00:00Z");
      expect(result.subscriptions.length).toBe(1);
      expect(result.subscriptions[0].name).toBe("alpha");
      expect(result.subscriptions[0].plan).toBe("Pro");
      expect(result.subscriptions[0].session5h.usageUsd).toBe(5.0);
      expect(result.subscriptions[0].weekly.usageUsd).toBe(20.0);
      expect(result.subscriptions[0].credits.includedUsd).toBe(100.0);
      expect(result.subscriptions[0].error).toBeNull();
    } finally {
      restore();
    }
  });

  it("falls back to the legacy /ollama-usage alias on 404", async () => {
    const { calls, restore } = stubGlobalFetch((call) => {
      if (call.url.pathname === "/subs-usage") {
        return new Response("not found", { status: 404 });
      }
      expect(call.url.pathname).toBe("/ollama-usage");
      return jsonResponse(sampleBody());
    });
    try {
      const result = await fetchUsageSubs("http://gw.example:4000", "sk-test", 5_000);
      expect(calls.map((call) => call.url.pathname)).toEqual([
        "/subs-usage", "/ollama-usage",
      ]);
      expect(result.subscriptions[0].name).toBe("alpha");
    } finally {
      restore();
    }
  });

  it("parses schema v2 identity fields (provider/account/status)", async () => {
    const { restore } = stubGlobalFetch(() =>
      jsonResponse({
        schemaVersion: 2,
        generatedAt: "2026-10-22T19:25:15Z",
        subscriptions: [{
          id: "claude:default", provider: "claude", account: "default",
          label: null, plan: "subscription", status: "critical",
          name: "default",
          session5h: { usageUsd: null, limitUsd: null, requests: null,
                       inputTokens: null, outputTokens: null, from: null, until: null },
          weekly: { usageUsd: null, limitUsd: null, requests: null,
                    inputTokens: null, outputTokens: null, from: null, until: null },
          credits: { includedUsd: null, includedBalanceUsd: null,
                     purchasedUsd: null,
                     session: { remainingPercent: 0,
                                resetsAt: "2026-10-22T19:49:59Z" },
                     weekly: null },
          error: null,
        }],
      }),
    );
    try {
      const result = await fetchUsageSubs("http://gw.example:4000", "sk-test", 5_000);
      const sub = result.subscriptions[0];
      expect(sub.provider).toBe("claude");
      expect(sub.account).toBe("default");
      expect(sub.status).toBe("critical");
      expect(sub.credits.session?.remainingPercent).toBe(0);
    } finally {
      restore();
    }
  });

  it("tolerates absent optional fields and missing subscriptions", async () => {
    const { restore } = stubGlobalFetch(() => jsonResponse({}));
    try {
      const result = await fetchUsageSubs("http://gw.example:4000", "sk-test", 5_000);
      expect(result.generatedAt).toBeNull();
      expect(result.subscriptions).toEqual([]);
    } finally {
      restore();
    }
  });

  it("maps 401 to AuthError", async () => {
    const { restore } = stubGlobalFetch(() => jsonResponse({ detail: "Invalid API key" }, 401));
    try {
      await expect(
        fetchUsageSubs("http://gw.example:4000", "sk-bad", 5_000),
      ).rejects.toThrow(AuthError);
      await expect(
        fetchUsageSubs("http://gw.example:4000", "sk-bad", 5_000),
      ).rejects.toThrow(/Credential rejected by gateway/);
    } finally {
      restore();
    }
  });

  it("maps 403 to the permission-flavored AuthError", async () => {
    const { restore } = stubGlobalFetch(() => jsonResponse({ detail: "no spend routes" }, 403));
    try {
      await expect(
        fetchUsageSubs("http://gw.example:4000", "sk-x", 5_000),
      ).rejects.toThrow(/Gateway denied access to usage-subs \(403\)/);
    } finally {
      restore();
    }
  });

  it("maps 404 to CatalogError 'usage-subs endpoint not available'", async () => {
    const { restore } = stubGlobalFetch(() => jsonResponse({ detail: "not found" }, 404));
    try {
      await expect(
        fetchUsageSubs("http://gw.example:4000", "sk-x", 5_000),
      ).rejects.toThrow(CatalogError);
      await expect(
        fetchUsageSubs("http://gw.example:4000", "sk-x", 5_000),
      ).rejects.toThrow(/usage-subs endpoint not available/);
    } finally {
      restore();
    }
  });

  it("maps invalid JSON to CatalogError", async () => {
    const { restore } = stubGlobalFetch(() => new Response("not json", { status: 200 }));
    try {
      await expect(
        fetchUsageSubs("http://gw.example:4000", "sk-x", 5_000),
      ).rejects.toThrow(CatalogError);
      await expect(
        fetchUsageSubs("http://gw.example:4000", "sk-x", 5_000),
      ).rejects.toThrow(/not valid JSON/);
    } finally {
      restore();
    }
  });
});

describe("formatUsageSubsLines", () => {
  it("renders gauge lines when limitUsd is present", () => {
    const lines = formatUsageSubsLines(sampleBody());
    expect(lines[0]).toMatch(/Usage subscriptions \(generated at \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(.+\)\):/);
    expect(lines[1].includes("Sub") && lines[1].includes("5h used") && lines[1].includes("Credits")).toBe(true);
    expect(lines.some((l) => l.includes("alpha (Pro)") && /\$5\.00 \/ \$10\.00/.test(l))).toBe(true);
    expect(lines.some((l) => /\$20\.00 \/ \$50\.00/.test(l))).toBe(true);
    expect(
      lines.some((l) =>
        l.includes("included $100.00 · balance $80.00 · purchased $20.00"),
      ),
    ).toBe(true);
  });

  it("renders absolute lines when limitUsd is absent", () => {
    const lines = formatUsageSubsLines({
      generatedAt: null,
      subscriptions: [
        {
          name: "beta",
          provider: null,
          account: null,
          status: null,
          plan: null,
          session5h: {
            usageUsd: 3.5,
            limitUsd: null,
            requests: 5,
            inputTokens: 100,
            outputTokens: 200,
            from: null,
            until: null,
          },
          weekly: {
            usageUsd: 14.0,
            limitUsd: null,
            requests: 50,
            inputTokens: 1000,
            outputTokens: 2000,
            from: null,
            until: null,
          },
          credits: {
            includedUsd: null,
            includedBalanceUsd: null,
            purchasedUsd: null,
            session: null,
            weekly: null,
          },
          error: null,
        },
      ],
    });
    expect(lines.some((l) => /\bbeta\b/.test(l))).toBe(true);
    expect(lines.some((l) => l.includes("(beta)"))).toBe(false);
    expect(lines.some((l) => /5 reqs · 300 tok/.test(l))).toBe(true);
    expect(lines.some((l) => /50 reqs · 3,000 tok/.test(l))).toBe(true);
    expect(lines.some((l) => l.includes("included $"))).toBe(false);
  });

  it("renders the per-subscription error instead of numeric lines", () => {
    const lines = formatUsageSubsLines({
      generatedAt: "2026-10-14T12:00:00Z",
      subscriptions: [
        {
          name: "gamma",
          provider: null,
          account: null,
          status: null,
          plan: "Basic",
          session5h: {
            usageUsd: null,
            limitUsd: null,
            requests: null,
            inputTokens: null,
            outputTokens: null,
            from: null,
            until: null,
          },
          weekly: {
            usageUsd: null,
            limitUsd: null,
            requests: null,
            inputTokens: null,
            outputTokens: null,
            from: null,
            until: null,
          },
          credits: {
            includedUsd: null,
            includedBalanceUsd: null,
            purchasedUsd: null,
            session: null,
            weekly: null,
          },
          error: "upstream rate limit exceeded",
        },
      ],
    });
    expect(lines.some((l) => l.includes("gamma (Basic)"))).toBe(true);
    expect(lines.some((l) => l.includes("(error: upstream rate limit exceeded)"))).toBe(true);
    expect(lines.some((l) => l.includes("included $"))).toBe(false);
  });

describe("formatUsageSubsLines schema v2", () => {
  it("prefixes the row with the provider when present", () => {
    const body = sampleBody() as unknown as Record<string, unknown>;
    const subs = body.subscriptions as Record<string, unknown>[];
    subs[0] = { ...subs[0], provider: "chatgpt", account: "alpha", status: "ok" };
    const text = formatUsageSubsLines(body as never).join("\n");
    expect(text).toContain("chatgpt:alpha (Pro)");
  });

  it("keeps legacy rows unprefixed when the payload has no provider", () => {
    const text = formatUsageSubsLines(sampleBody()).join("\n");
    expect(text).toContain("alpha (Pro)");
    expect(text).not.toContain("chatgpt:");
  });
});

describe("formatUsageSubsLines colors", () => {
  const GREEN = "\x1b[38;2;34;197;94m";
  const YELLOW = "\x1b[38;2;234;179;8m";
  const ORANGE = "\x1b[38;2;249;115;22m";
  const RED = "\x1b[38;2;239;68;68m";

  function quotaSubs(session: number | null, weekly: number | null): UsageSubscriptions {
    return {
      generatedAt: "2026-10-14T12:00:00Z",
      subscriptions: [
        {
          name: "legacy",
          provider: null,
          account: null,
          status: null,
          plan: null,
          session5h: {
            usageUsd: null, limitUsd: null, requests: 100,
            inputTokens: null, outputTokens: null, from: null, until: null,
          },
          weekly: {
            usageUsd: null, limitUsd: null, requests: 100,
            inputTokens: null, outputTokens: null, from: null, until: null,
          },
          credits: {
            includedUsd: null, includedBalanceUsd: null, purchasedUsd: 0,
            session: session == null ? null : { remainingPercent: session, resetsAt: "2026-10-14T15:00:00Z" },
            weekly: weekly == null ? null : { remainingPercent: weekly, resetsAt: "2026-10-19T00:00:00Z" },
          },
          error: null,
        },
      ],
    };
  }

  function gaugeRow(lines: string[]): string {
    // The quota gauge cell lives in the row of the "legacy" subscription.
    const row = lines.find((l) => l.startsWith("legacy"));
    expect(row).toBeDefined();
    return row!;
  }

  it("colors the gauge green when used is <= 50%", () => {
    const lines = formatUsageSubsLines(quotaSubs(60, null), { color: true });
    expect(gaugeRow(lines).includes(`${GREEN}\u25b0`)).toBe(true);
  });

  it("colors the gauge yellow at 51-75%, orange at 76-90%, red above 90%", () => {
    const yellow = formatUsageSubsLines(quotaSubs(40, null), { color: true });
    expect(gaugeRow(yellow).includes(YELLOW)).toBe(true);
    const orange = formatUsageSubsLines(quotaSubs(15, null), { color: true });
    expect(gaugeRow(orange).includes(ORANGE)).toBe(true);
    const red = formatUsageSubsLines(quotaSubs(5, null), { color: true });
    expect(gaugeRow(red).includes(RED)).toBe(true);
  });

  it("emits no ANSI by default (color off, wired surface)", () => {
    const plain = formatUsageSubsLines(quotaSubs(85, 90));
    expect(plain.some((l) => l.includes("\x1b["))).toBe(false);
  });
});

describe("formatUsageSubsLines window pace", () => {
  const GREEN = "\x1b[38;2;34;197;94m";
  const YELLOW = "\x1b[38;2;234;179;8m";

  /** Quota subscription with a per-window reset instant for pace control. */
  function pacedQuotaSubs(
    sessionRemaining: number,
    sessionResetsAt: string,
  ): UsageSubscriptions {
    return {
      generatedAt: "2026-10-14T12:00:00Z",
      subscriptions: [
        {
          name: "paced",
          provider: null,
          account: null,
          status: null,
          plan: null,
          session5h: {
            usageUsd: null, limitUsd: null, requests: 40,
            inputTokens: null, outputTokens: null, from: null, until: null,
          },
          weekly: {
            usageUsd: null, limitUsd: null, requests: 40,
            inputTokens: null, outputTokens: null, from: null, until: null,
          },
          credits: {
            includedUsd: null, includedBalanceUsd: null, purchasedUsd: 0,
            session: { remainingPercent: sessionRemaining, resetsAt: sessionResetsAt },
            weekly: null,
          },
          error: null,
        },
      ],
    };
  }

  it("escalates the color and projects when usage runs ahead of the window", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-14T12:00:00Z"));
    // remainingPercent 85 -> used 15; reset at 16:30 leaves 4.5h of the 5h window:
    // elapsed 10% (floor), pace 1.5.
    const colored = formatUsageSubsLines(pacedQuotaSubs(85, "2026-10-14T16:30:00Z"), { color: true });
    const row = colored.find((l) => l.startsWith("paced"));
    expect(row).toBeDefined();
    expect(row!.includes(YELLOW)).toBe(true);
    expect(row!.replace(/\x1b\[[0-9;]*m/g, "")).toMatch(/15% → 150%/);
  });

  it("shows no projection and keeps the base color when usage is on or under pace", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-14T12:00:00Z"));
    // Reset at 15:00 leaves 3h: elapsed 40%; used 15% -> pace 0.375.
    const lines = formatUsageSubsLines(pacedQuotaSubs(85, "2026-10-14T15:00:00Z"), { color: true });
    const row = lines.find((l) => l.startsWith("paced"));
    expect(row).toBeDefined();
    expect(row!.includes(GREEN)).toBe(true);
    expect(row!.includes("→")).toBe(false);
  });

  it("projects from explicit window bounds and caps the projection for the dollar path", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-14T12:00:00Z"));
    // Window 11:55-16:55: elapsed 1.67% -> floored to 10%; used 50% -> pace 5,
    // projection capped at 200%.
    const lines = formatUsageSubsLines({
      generatedAt: null,
      subscriptions: [
        {
          name: "dollar",
          provider: null,
          account: null,
          status: null,
          plan: null,
          session5h: {
            usageUsd: 5.0, limitUsd: 10.0, requests: 8,
            inputTokens: null, outputTokens: null,
            from: "2026-10-14T11:55:00Z", until: "2026-10-14T16:55:00Z",
          },
          weekly: {
            usageUsd: 20.0, limitUsd: 50.0, requests: 80,
            inputTokens: null, outputTokens: null, from: null, until: null,
          },
          credits: {
            includedUsd: null, includedBalanceUsd: null, purchasedUsd: 0,
            session: null, weekly: null,
          },
          error: null,
        },
      ],
    }, { color: true });
    const row = lines.find((l) => l.startsWith("dollar"));
    expect(row).toBeDefined();
    const visible = row!.replace(/\x1b\[[0-9;]*m/g, "");
    expect(visible).toMatch(/\$5\.00 \/ \$10\.00 → 200%/);
    expect(row!.includes(YELLOW)).toBe(true);
  });

  it("omits the projection when no window boundary is known", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-14T12:00:00Z"));
    const lines = formatUsageSubsLines({
      generatedAt: null,
      subscriptions: [
        {
          name: "opaque",
          provider: null,
          account: null,
          status: null,
          plan: null,
          session5h: {
            usageUsd: 5.0, limitUsd: 10.0, requests: 8,
            inputTokens: null, outputTokens: null, from: null, until: null,
          },
          weekly: {
            usageUsd: 2.0, limitUsd: 50.0, requests: 8,
            inputTokens: null, outputTokens: null, from: null, until: null,
          },
          credits: {
            includedUsd: null, includedBalanceUsd: null, purchasedUsd: 0,
            session: null, weekly: null,
          },
          error: null,
        },
      ],
    }, { color: true });
    const row = lines.find((l) => l.startsWith("opaque"));
    expect(row).toBeDefined();
    const visible = row!.replace(/\x1b\[[0-9;]*m/g, "");
    expect(visible).toMatch(/\$5\.00 \/ \$10\.00(?! →)/);
    expect(row!.includes(GREEN)).toBe(true);
  });
});

describe("formatUsageSubsLines window pace collector bounds", () => {
  const GREEN = "\x1b[38;2;34;197;94m";
  const ORANGE = "\x1b[38;2;249;115;22m";

  it("defers to the quota reset when the collector bounds end at generation time (regression #17)", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-15T17:34:00Z"));
    // Live collector semantics: until == generation time (closed measurement
    // range). Live row was 57% used with reset 3 h 26 min away: elapsed ~31%,
    // pace 1.82 -> orange + projection; the defect rendered yellow silently.
    const lines = formatUsageSubsLines({
      generatedAt: "2026-10-15T17:34:00Z",
      subscriptions: [
        {
          name: "live-bug",
          provider: null,
          account: null,
          status: null,
          plan: "Pro",
          session5h: {
            usageUsd: null, limitUsd: null, requests: 2752,
            inputTokens: null, outputTokens: null,
            from: "2026-10-15T12:34:00Z", until: "2026-10-15T17:34:00Z",
          },
          weekly: {
            usageUsd: null, limitUsd: null, requests: 15568,
            inputTokens: null, outputTokens: null, from: null, until: null,
          },
          credits: {
            includedUsd: null, includedBalanceUsd: null, purchasedUsd: 0,
            session: { remainingPercent: 43, resetsAt: "2026-10-15T21:00:00Z" },
            weekly: { remainingPercent: 63, resetsAt: "2026-10-19T00:30:00Z" },
          },
          error: null,
        },
      ],
    }, { color: true });
    const row = lines.find((l) => l.startsWith("live-bug"));
    expect(row).toBeDefined();
    const visible = row!.replace(/\x1b\[[0-9;]*m/g, "");
    expect(visible).toMatch(/57% → 182%/);
    expect(row!.includes(ORANGE)).toBe(true);
  });

  it("renders no projection when the dollar window range is closed (until <= now)", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-15T17:34:00Z"));
    const lines = formatUsageSubsLines({
      generatedAt: null,
      subscriptions: [
        {
          name: "closed",
          provider: null,
          account: null,
          status: null,
          plan: null,
          session5h: {
            usageUsd: 6.0, limitUsd: 10.0, requests: 9,
            inputTokens: null, outputTokens: null,
            from: "2026-10-15T12:34:00Z", until: "2026-10-15T17:34:00Z",
          },
          weekly: {
            usageUsd: 1.0, limitUsd: 50.0, requests: 9,
            inputTokens: null, outputTokens: null, from: null, until: null,
          },
          credits: {
            includedUsd: null, includedBalanceUsd: null, purchasedUsd: 0,
            session: null, weekly: null,
          },
          error: null,
        },
      ],
    }, { color: true });
    const row = lines.find((l) => l.startsWith("closed"));
    expect(row).toBeDefined();
    const visible = row!.replace(/\x1b\[[0-9;]*m/g, "");
    expect(visible.includes("→")).toBe(false);
    expect(row!.includes(GREEN)).toBe(true);
  });
});

  it("renders the legacy quota gauge and remaining reset durations", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-14T12:00:00Z"));
    const lines = formatUsageSubsLines({
      generatedAt: "2026-10-14T12:00:00Z",
      subscriptions: [
        {
          name: "legacy",
          provider: null,
          account: null,
          status: null,
          plan: null,
          session5h: {
            usageUsd: null,
            limitUsd: null,
            requests: 642,
            inputTokens: null,
            outputTokens: null,
            from: null,
            until: null,
          },
          weekly: {
            usageUsd: null,
            limitUsd: null,
            requests: 15740,
            inputTokens: null,
            outputTokens: null,
            from: null,
            until: null,
          },
          credits: {
            includedUsd: null,
            includedBalanceUsd: null,
            purchasedUsd: 0,
            session: { remainingPercent: 85.47, resetsAt: "2026-10-14T15:00:00Z" },
            weekly: { remainingPercent: 88.15, resetsAt: "2026-10-19T00:00:00Z" },
          },
          error: null,
        },
      ],
    });
    // One table row carries both windows and their resets (used = 100 - remaining:
    // 85.47 -> ~15%, 88.15 -> ~12%); padded columns collapse to \s+ in patterns.
    expect(
      lines.some((l) =>
        /legacy\s+.*15% 642 reqs\s+3 h 0 min\s+.*12% 15,740 reqs\s+4 d 12 h\s+purchased \$0\.00/.test(l),
      ),
    ).toBe(true);
  });

  it("shows the no-subscriptions message for an empty list", () => {
    const lines = formatUsageSubsLines({ generatedAt: null, subscriptions: [] });
    expect(lines[0]).toMatch(/Usage subscriptions/);
    expect(lines[1]).toMatch(/\(no subscriptions returned\)/);
  });
});

function makeToolContext() {
  return {
    sessionID: "session-1",
    messageID: "msg-1",
    agent: "agent-1",
    id: "call-1",
    signal: new AbortController().signal,
    progress: async () => {},
  };
}

describe("actsis_litellm_usage_subs tool", () => {
  let tmpDir: string;
  let authPath: string;
  const savedEnv: { stateDir?: string; dataHome?: string } = {};

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "actsis-litellm-usage-subs-test-"));
    authPath = path.join(tmpDir, "auth.json");
    savedEnv.stateDir = process.env.ACTSIS_LITELLM_STATE_DIR;
    savedEnv.dataHome = process.env.XDG_DATA_HOME;
    process.env.ACTSIS_LITELLM_STATE_DIR = tmpDir;
    process.env.XDG_DATA_HOME = tmpDir;
    await writeFile(
      path.join(tmpDir, "state.json"),
      JSON.stringify({ version: 1, gatewayUrl: "https://gw.example.com" }),
    );
    await writeFile(
      authPath,
      JSON.stringify({ "actsis-litellm": { type: "api", key: "sk-test" } }),
    );
  });

  afterEach(async () => {
    if (savedEnv.stateDir !== undefined) process.env.ACTSIS_LITELLM_STATE_DIR = savedEnv.stateDir;
    else delete process.env.ACTSIS_LITELLM_STATE_DIR;
    if (savedEnv.dataHome !== undefined) process.env.XDG_DATA_HOME = savedEnv.dataHome;
    else delete process.env.XDG_DATA_HOME;
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeDeps(extra?: Partial<ToolDeps>): ToolDeps {
    return {
      providerId: "actsis-litellm",
      stateDir: tmpDir,
      authPath,
      ...extra,
    };
  }

  function usageSubsExecute(deps: ToolDeps) {
    const info = buildLitellmToolInfos(deps).find((t) => t.name === "actsis_litellm_usage_subs")!;
    return (input: Record<string, unknown>) =>
      info.execute(input, makeToolContext()) as Promise<{ content: string }>;
  }

  it("exposes actsis_litellm_usage_subs with fixed (empty) input", () => {
    const infos = buildLitellmToolInfos({ providerId: "actsis-litellm" });
    const usageSubs = infos.find((t) => t.name === "actsis_litellm_usage_subs");
    expect(usageSubs).toBeDefined();
    expect(usageSubs!.input).toMatchObject({ type: "object", additionalProperties: false });
    expect(typeof usageSubs!.execute).toBe("function");
  });

  it("renders the per-subscription usage from the gateway", async () => {
    const { restore } = stubGlobalFetch((call) => {
      expect(call.url.pathname).toBe("/subs-usage");
      return jsonResponse(sampleBody());
    });
    try {
      const result = await usageSubsExecute(makeDeps())({});
      expect(result.content).toContain("alpha (Pro)");
      expect(result.content).toContain("5h used");
      expect(result.content).toContain("$20.00 / $50.00");
      expect(result.content).toContain("included $100.00");
      // Wired with {color: true}: gauge cells carry truecolor runs (sampleBody
      // session/weekly quotas are null, so the limitUsd path colors green).
      expect(result.content).toContain("\x1b[38;2;34;197;94m");
      expect(result.content).toContain("\x1b[2;39m");
    } finally {
      restore();
    }
  });

  it("returns a not-signed-in answer when no credential is stored", async () => {
    await rm(authPath, { force: true });
    const result = await usageSubsExecute(makeDeps())({});
    expect(result.content).toContain("Not signed in");
  });

  it("returns gateway-not-configured when state has no gatewayUrl", async () => {
    await writeFile(path.join(tmpDir, "state.json"), JSON.stringify({ version: 1 }));
    const result = await usageSubsExecute(makeDeps())({});
    expect(result.content).toBe("Gateway URL not configured.");
  });

  it("returns the credential-rejected message on 401", async () => {
    const { restore } = stubGlobalFetch(() => jsonResponse("unauthorized", 401));
    try {
      const result = await usageSubsExecute(makeDeps())({});
      expect(result.content).toBe("Credential rejected by gateway. Run /login again.");
    } finally {
      restore();
    }
  });

  it("returns a clear error when the usage-subs request fails", async () => {
    const { restore } = stubGlobalFetch(() => jsonResponse("not found", 404));
    try {
      const result = await usageSubsExecute(makeDeps())({});
      expect(result.content).toContain("Usage subscriptions unavailable:");
      expect(result.content).toContain("usage-subs endpoint not available");
    } finally {
      restore();
    }
  });
});

describe("actsis-litellm:usage-subs command", () => {
  it("is exposed in buildCommandDefinitions", () => {
    const commands = buildCommandDefinitions();
    const names = commands.map((c) => c.name);
    expect(names).toContain("actsis-litellm-usage-subs");
    const command = commands.find((c) => c.name === "actsis-litellm-usage-subs")!;
    expect(command.description).toContain("per-subscription Ollama Cloud usage");
    expect(command.template).toContain("actsis_litellm_usage_subs tool");
  });

  it("is skipped when already registered", () => {
    const commands = buildCommandDefinitions([{ name: "actsis-litellm-usage-subs" }]);
    expect(commands.map((c) => c.name)).not.toContain("actsis-litellm-usage-subs");
  });
});

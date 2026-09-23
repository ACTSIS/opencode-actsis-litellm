import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { GatewayBudgetSnapshot } from "../src/budget.ts";
import {
  budgetWidgetLine,
  readBudgetWidgetData,
  type BudgetWidgetData,
} from "../src/budget-widget.ts";

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeStateDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "budget-widget-"));
  tempDirs.push(dir);
  return dir;
}

async function writeState(dir: string, content: string): Promise<void> {
  await mkdir(path.join(dir, "actsis-litellm"), { recursive: true });
  await writeFile(path.join(dir, "actsis-litellm", "state.json"), content);
}

function snapshotWith(
  primary: Partial<GatewayBudgetSnapshot["primary"]>,
): GatewayBudgetSnapshot {
  return {
    primary: {
      spend: null,
      maxBudget: null,
      tpmLimit: null,
      rpmLimit: null,
      budgetResetAt: null,
      keyAlias: null,
      ...primary,
    },
    ownKeys: [],
    source: "key_info",
  };
}

const fresh: BudgetWidgetData = {
  snapshot: snapshotWith({ spend: 12.34, maxBudget: 100 }),
  refreshedAt: 1_000_000,
};

describe("budgetWidgetLine", () => {
  it("returns null without a snapshot", () => {
    expect(budgetWidgetLine({}, 2_000_000)).toBeNull();
  });

  it("returns null when refreshedAt is missing or non-finite", () => {
    expect(budgetWidgetLine({ snapshot: fresh.snapshot }, 2_000_000)).toBeNull();
    expect(
      budgetWidgetLine(
        { snapshot: fresh.snapshot, refreshedAt: Number.NaN },
        2_000_000,
      ),
    ).toBeNull();
    expect(
      budgetWidgetLine(
        { snapshot: fresh.snapshot, refreshedAt: Number.POSITIVE_INFINITY },
        2_000_000,
      ),
    ).toBeNull();
  });

  it("returns null when the snapshot is older than maxAgeSeconds", () => {
    const stale: BudgetWidgetData = { ...fresh, refreshedAt: 1_000_000_000 };
    expect(budgetWidgetLine(stale, 1_000_000_000 + 61_000, 60)).toBeNull();
  });

  it("returns the exact gauge line when fresh", () => {
    expect(budgetWidgetLine(fresh, 1_000_000 + 30_000, 60)).toBe(
      "Budget ▰▱▱▱▱▱▱▱ 12% · $12.34/$100.00",
    );
  });

  it("returns the uncapped form when maxBudget is null", () => {
    const uncapped: BudgetWidgetData = {
      snapshot: snapshotWith({ spend: 5, maxBudget: null }),
      refreshedAt: 1_000_000,
    };
    expect(budgetWidgetLine(uncapped, 1_000_100)).toBe(
      "Budget $5.00 used (no cap)",
    );
  });

  it('returns "Budget: no spend data" when spend is null', () => {
    const noSpend: BudgetWidgetData = {
      snapshot: snapshotWith({ spend: null, maxBudget: 100 }),
      refreshedAt: 1_000_000,
    };
    expect(budgetWidgetLine(noSpend, 1_000_100)).toBe("Budget: no spend data");
  });
});

describe("readBudgetWidgetData", () => {
  it("parses a valid state file", async () => {
    const dir = await makeStateDir();
    await writeState(
      dir,
      JSON.stringify({
        lastBudgetSnapshot: fresh.snapshot,
        budgetRefreshedAt: 1_234_567,
      }),
    );
    expect(await readBudgetWidgetData(dir)).toEqual({
      snapshot: fresh.snapshot,
      refreshedAt: 1_234_567,
    });
  });

  it("returns null for malformed JSON", async () => {
    const dir = await makeStateDir();
    await writeState(dir, "{not json");
    expect(await readBudgetWidgetData(dir)).toBeNull();
  });

  it("returns null when the file is missing", async () => {
    const dir = await makeStateDir();
    expect(await readBudgetWidgetData(dir)).toBeNull();
  });

  it("returns null when lastBudgetSnapshot is absent", async () => {
    const dir = await makeStateDir();
    await writeState(dir, JSON.stringify({ budgetRefreshedAt: 1 }));
    expect(await readBudgetWidgetData(dir)).toBeNull();
  });

  it("omits refreshedAt when it is not a finite number", async () => {
    const dir = await makeStateDir();
    await writeState(
      dir,
      JSON.stringify({
        lastBudgetSnapshot: fresh.snapshot,
        budgetRefreshedAt: "soon",
      }),
    );
    const data = await readBudgetWidgetData(dir);
    expect(data?.snapshot).toEqual(fresh.snapshot);
    expect(data?.refreshedAt).toBeUndefined();
  });
});
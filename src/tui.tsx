/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui";
import type { Context } from "@opencode/plugin/tui/plugin";
import type { SlotClaim } from "@opencode/plugin/tui/context";
import { createSignal } from "solid-js";
import {
  budgetWidgetLine,
  readBudgetWidgetData,
  type BudgetWidgetData,
} from "./budget-widget.ts";
import {
  readTopWidgetData,
  topWidgetLines,
  type TopWidgetData,
} from "./top-widget.ts";
import { readTopModelsWidgetEnabled } from "./preferences.ts";

const IDLE_REFRESH_DEBOUNCE_MS = 2000;

export default Plugin.define({
  id: "actsis-litellm-budget",
  async setup(context: Context) {
    let data: BudgetWidgetData | null = null;
    let top: TopWidgetData | null = null;
    try {
      data = await readBudgetWidgetData();
      if (await readTopModelsWidgetEnabled()) {
        top = await readTopWidgetData();
      }
    } catch {
      data = null;
      top = null;
    }
    const [line, setLine] = createSignal<string | null>(
      data ? budgetWidgetLine(data, Date.now()) : null,
    );
    const [topLines, setTopLines] = createSignal<string[] | null>(
      top ? topWidgetLines(top, Date.now()) : null,
    );

    let timeout: ReturnType<typeof setTimeout> | undefined;

    const refresh = async () => {
      try {
        const next = await readBudgetWidgetData();
        setLine(next ? budgetWidgetLine(next, Date.now()) : null);
        // The server plugin persists (or clears) the top-5 rows on the same
        // session.idle trigger; show them only when the preference is on.
        const topData = await readTopWidgetData();
        setTopLines(
          (await readTopModelsWidgetEnabled()) && topData
            ? topWidgetLines(topData, Date.now())
            : null,
        );
      } catch {
        setLine(null);
        setTopLines(null);
      }
    };

    context.ui.slot({
      append: "sidebar.footer",
      render: (_input: { sessionID: string } & Record<string, never>) => {
        return line() || topLines() ? (
          <box>
            <text>{line()}</text>
            {topLines() && <text>{topLines()!.join("\n")}</text>}
          </box>
        ) : null;
      },
    } as SlotClaim);

    // The server plugin persists a fresh snapshot on the same "session.idle"
    // event; debounce so the server-side write wins the race before we re-read.
    const unsubIdle = context.data.on("session.idle", () => {
      if (timeout !== undefined) clearTimeout(timeout);
      timeout = setTimeout(() => void refresh(), IDLE_REFRESH_DEBOUNCE_MS);
    });

    // Covers TUI restarts with an existing snapshot on disk.
    void refresh();

    return () => {
      unsubIdle();
      if (timeout !== undefined) clearTimeout(timeout);
    };
  },
});
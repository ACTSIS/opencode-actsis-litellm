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
import {
  WIDGET_REFRESH_EVENT_TYPES,
  type WidgetRefreshEventType,
} from "./widget-events.ts";

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

    // The server plugin persists a fresh snapshot on the same widget refresh
    // events; debounce so the server-side write wins the race before we
    // re-read. opencode v2 emits session.execution.* (not the deprecated
    // session.idle), so subscribe to every trigger type.
    const unsubscribers = WIDGET_REFRESH_EVENT_TYPES.map((type) =>
      context.data.on(type satisfies WidgetRefreshEventType, () => {
        if (timeout !== undefined) clearTimeout(timeout);
        timeout = setTimeout(() => void refresh(), IDLE_REFRESH_DEBOUNCE_MS);
      }),
    );

    // Covers TUI restarts with an existing snapshot on disk.
    void refresh();

    // Periodic safety net: re-render from the persisted snapshot even if no
    // refresh event arrives (e.g. older hosts or missed events).
    const pollTimer = setInterval(() => void refresh(), 60_000);

    return () => {
      for (const unsub of unsubscribers) unsub();
      if (timeout !== undefined) clearTimeout(timeout);
      clearInterval(pollTimer);
    };
  },
});
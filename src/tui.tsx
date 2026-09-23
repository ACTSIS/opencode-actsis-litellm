/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { createSignal } from "solid-js";
import {
  budgetWidgetLine,
  readBudgetWidgetData,
  type BudgetWidgetData,
} from "./budget-widget.ts";

const IDLE_REFRESH_DEBOUNCE_MS = 2000;

const tui: TuiPlugin = async (api, _options, _meta) => {
  let data: BudgetWidgetData | null = null;
  try {
    data = await readBudgetWidgetData();
  } catch {
    data = null;
  }
  const [line, setLine] = createSignal<string | null>(
    data ? budgetWidgetLine(data, Date.now()) : null,
  );

  let timeout: ReturnType<typeof setTimeout> | undefined;

  const refresh = async () => {
    try {
      const next = await readBudgetWidgetData();
      setLine(next ? budgetWidgetLine(next, Date.now()) : null);
    } catch {
      setLine(null);
    }
  };

  api.slots.register({
    order: 80,
    slots: {
      sidebar_footer(_ctx, _props) {
        return line() ? (
          <box>
            <text>{line()}</text>
          </box>
        ) : null;
      },
    },
  });

  // The server plugin persists a fresh snapshot on the same "session.idle"
  // event; debounce so the server-side write wins the race before we re-read.
  const unsubIdle = api.event.on("session.idle", () => {
    timeout = setTimeout(() => void refresh(), IDLE_REFRESH_DEBOUNCE_MS);
  });

  // Covers TUI restarts with an existing snapshot on disk.
  void refresh();

  api.lifecycle.onDispose(() => {
    unsubIdle();
    if (timeout !== undefined) clearTimeout(timeout);
  });
};

const plugin: TuiPluginModule & { id: string } = {
  id: "actsis-litellm-budget",
  tui,
};

export default plugin;
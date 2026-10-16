/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui";
import type { Context } from "@opencode/plugin/tui/plugin";
import type { SlotClaim } from "@opencode/plugin/tui/context";
import { createSignal } from "solid-js";
import { TextNodeRenderable, TextRenderable } from "@opentui/core";
import type { Renderable } from "@opentui/core";
import { parseAnsiRuns } from "./ansi.ts";
import {
  budgetWidgetSegments,
  readBudgetWidgetData,
  type BudgetWidgetData,
  type WidgetSegment,
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

/**
 * Build a line-preserving text renderable from raw ANSI text for the chat
 * transcript. The chat's default code-block rendering shows embedded SGR
 * literally, so the plugin registers this as the renderer for ```ansi fenced
 * blocks (same mechanism opencode uses for its built-in latex and mermaid
 * renderers). Runs preserve the SGR colors the gateway surfaces emit.
 */
function ansiCodeBlockRenderer(
  renderer: Context["renderer"],
): (token: { text: string }) => Renderable {
  return (token: { text: string }) => {
    const text = new TextRenderable(renderer, {
      width: "100%",
      flexShrink: 0,
      wrapMode: "none",
      selectable: false,
    });
    for (const run of parseAnsiRuns(token.text)) {
      const node = new TextNodeRenderable(run.fg === undefined ? {} : { fg: run.fg });
      node.add(run.text);
      text.add(node);
    }
    return text;
  };
}

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
    const [line, setLine] = createSignal<WidgetSegment[] | null>(
      data ? budgetWidgetSegments(data, Date.now()) : null,
    );
    const [topLines, setTopLines] = createSignal<string[] | null>(
      top ? topWidgetLines(top, Date.now()) : null,
    );

    let timeout: ReturnType<typeof setTimeout> | undefined;

    const refresh = async () => {
      try {
        const next = await readBudgetWidgetData();
        setLine(next ? budgetWidgetSegments(next, Date.now()) : null);
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

    let unregisterAnsiRenderer: (() => void) | undefined;
    try {
      unregisterAnsiRenderer = context.markdown.registerCodeBlockRenderer(
        "ansi",
        ansiCodeBlockRenderer(context.renderer),
      );
    } catch {
      // Language already claimed on this host (e.g. a hot-reload race): the
      // host default (uncolored) code block keeps working.
    }

    context.ui.slot({
      append: "sidebar.footer",
      render: (_input: { sessionID: string } & Record<string, never>) => {
        return line() || topLines() ? (
          <box>
            <text>
              {line()?.map((segment) => {
                // OpenTUI's reconciler applies `style` ({ fg }) on text-node
                // renderables and silently ignores any other props — a bare
                // `fg` prop renders plain white, which is what this widget
                // showed before this fix.
                return segment.fg === undefined ? (
                  <span>{segment.text}</span>
                ) : (
                  <span style={{ fg: segment.fg } as Record<string, unknown>}>
                    {segment.text}
                  </span>
                );
              })}
            </text>
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
      unregisterAnsiRenderer?.();
      for (const unsub of unsubscribers) unsub();
      if (timeout !== undefined) clearTimeout(timeout);
      clearInterval(pollTimer);
    };
  },
});
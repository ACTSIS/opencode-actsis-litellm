// src/tui.tsx
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { createSignal } from "solid-js";

// src/budget-widget.ts
import { readFile } from "fs/promises";
import os from "os";
import path from "path";

// src/budget.ts
function budgetUsagePercent(spend, maxBudget) {
  if (maxBudget === null || maxBudget <= 0) return 0;
  return (spend ?? 0) / maxBudget * 100;
}
var GAUGE_CELLS = 8;
var GAUGE_FILLED = "\u25B0";
var GAUGE_EMPTY = "\u25B1";
function budgetGauge(percent) {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round(clamped / 100 * GAUGE_CELLS);
  return GAUGE_FILLED.repeat(filled) + GAUGE_EMPTY.repeat(GAUGE_CELLS - filled);
}
function formatBudgetStatus(info) {
  if (info.spend === null) return void 0;
  const spend = `$${info.spend.toFixed(2)}`;
  if (info.maxBudget !== null && info.maxBudget > 0) {
    const percent = budgetUsagePercent(info.spend, info.maxBudget);
    const cap = `$${info.maxBudget.toFixed(2)}`;
    return `Budget ${budgetGauge(percent)} ${Math.round(percent)}% \xB7 ${spend}/${cap}`;
  }
  return `Budget ${spend} used (no cap)`;
}

// src/budget-widget.ts
function budgetWidgetLine(data, now, maxAgeSeconds) {
  if (!data.snapshot) return null;
  if (typeof data.refreshedAt !== "number" || !Number.isFinite(data.refreshedAt)) {
    return null;
  }
  if (maxAgeSeconds !== void 0 && (now - data.refreshedAt) / 1e3 > maxAgeSeconds) {
    return null;
  }
  const status = formatBudgetStatus(data.snapshot.primary);
  if (status !== void 0) return status;
  return "Budget: no spend data";
}
function defaultStateDir() {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return path.join(xdg, "opencode");
  return path.join(os.homedir(), ".local", "share", "opencode");
}
async function readBudgetWidgetData(dir) {
  const base = dir ?? defaultStateDir();
  const file = path.join(base, "actsis-litellm", "state.json");
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed;
  const snapshot = record.lastBudgetSnapshot;
  if (typeof snapshot !== "object" || snapshot === null) return null;
  if (typeof snapshot.primary !== "object" || snapshot.primary === null) {
    return null;
  }
  const refreshedAt = record.budgetRefreshedAt;
  return {
    snapshot,
    refreshedAt: typeof refreshedAt === "number" && Number.isFinite(refreshedAt) ? refreshedAt : void 0
  };
}

// src/tui.tsx
var IDLE_REFRESH_DEBOUNCE_MS = 2e3;
var tui = async (api, _options, _meta) => {
  let data = null;
  try {
    data = await readBudgetWidgetData();
  } catch {
    data = null;
  }
  const [line, setLine] = createSignal(data ? budgetWidgetLine(data, Date.now()) : null);
  let timeout;
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
        return line() ? (() => {
          var _el$ = _$createElement("box"), _el$2 = _$createElement("text");
          _$insertNode(_el$, _el$2);
          _$insert(_el$2, line);
          return _el$;
        })() : null;
      }
    }
  });
  const unsubIdle = api.event.on("session.idle", () => {
    timeout = setTimeout(() => void refresh(), IDLE_REFRESH_DEBOUNCE_MS);
  });
  void refresh();
  api.lifecycle.onDispose(() => {
    unsubIdle();
    if (timeout !== void 0) clearTimeout(timeout);
  });
};
var plugin = {
  id: "actsis-litellm-budget",
  tui
};
var tui_default = plugin;
export {
  tui_default as default
};

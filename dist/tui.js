// src/tui.tsx
import { insertNode as _$insertNode } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { Plugin } from "@opencode/plugin/tui";
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

// src/top-widget.ts
import { readFile as readFile2 } from "fs/promises";
import os2 from "os";
import path2 from "path";

// src/usage.ts
var DAY_MS = 24 * 60 * 60 * 1e3;

// src/top-widget.ts
var TOP_MODELS_ROW_LIMIT = 5;
var TOP_WIDGET_WINDOW_LABEL = "7d";
var TOP_MODELS_TTL_MS = 5 * 60 * 1e3;
function nbspRuns(text) {
  return text.replace(/ {2,}/g, (run) => "\xA0".repeat(run.length));
}
function usageGauge(percent) {
  return budgetGauge(Number.isFinite(percent) ? percent : 0);
}
var WIDGET_PCT_WIDTH = 3;
var WIDGET_NAME_WIDTH = 26;
var WIDGET_SPEND_MIN_WIDTH = "$0.00".length;
function buildTopModelsWidgetLines(options) {
  const maxRows = options.maxRows ?? TOP_MODELS_ROW_LIMIT;
  const maxNameWidth = options.maxNameWidth ?? WIDGET_NAME_WIDTH;
  const rows = options.rows.slice(0, maxRows).map((row) => ({
    model: row.model.length > maxNameWidth ? `${row.model.slice(0, maxNameWidth - 1)}\u2026` : row.model,
    spend: row.spend
  }));
  if (rows.length === 0) return [];
  const windowTotal = totalSpendOf(options.totalSpend, rows);
  const titleSpendPart = options.totalSpend !== null && options.totalSpend !== void 0 ? ` \xB7 $${options.totalSpend.toFixed(2)}` : "";
  const nameWidth = Math.max(0, ...rows.map((r) => r.model.length));
  const spendWidth = Math.max(
    WIDGET_SPEND_MIN_WIDTH,
    ...rows.map((r) => `$${r.spend.toFixed(2)}`.length)
  );
  const tableWidth = nameWidth + 1 + spendWidth + 1 + WIDGET_PCT_WIDTH + 1 + 1 + 8;
  const lines = [
    `Top models (${options.windowLabel})${titleSpendPart}`
  ];
  lines.push("=".repeat(tableWidth));
  for (const row of rows) {
    const share = windowTotal > 0 ? Math.min(100, Math.max(0, row.spend / windowTotal * 100)) : 0;
    const raw = `${row.model.padEnd(nameWidth)} ${`$${row.spend.toFixed(2)}`.padStart(spendWidth)} ${String(Math.round(share)).padStart(WIDGET_PCT_WIDTH)}% ${usageGauge(share)}`;
    lines.push(nbspRuns(raw));
  }
  return lines;
}
function totalSpendOf(totalSpend, rows) {
  return totalSpend !== null && totalSpend !== void 0 ? totalSpend : rows.reduce((sum, r) => sum + r.spend, 0);
}
function topWidgetLines(data, now, maxAgeSeconds) {
  if (!data.rows || data.rows.length === 0) return null;
  if (!Number.isFinite(data.refreshedAt)) return null;
  if (maxAgeSeconds !== void 0 && (now - data.refreshedAt) / 1e3 > maxAgeSeconds) {
    return null;
  }
  return buildTopModelsWidgetLines({
    windowLabel: data.windowLabel,
    rows: data.rows,
    totalSpend: data.totalSpend
  });
}
function defaultStateDir2() {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return path2.join(xdg, "opencode");
  return path2.join(os2.homedir(), ".local", "share", "opencode");
}
function rowFromUnknown(value) {
  if (typeof value !== "object" || value === null) return null;
  const record = value;
  if (typeof record.model !== "string" || !record.model) return null;
  if (typeof record.spend !== "number" || !Number.isFinite(record.spend)) {
    return null;
  }
  return { model: record.model, spend: record.spend };
}
function rowsFromUnknown(value) {
  if (typeof value !== "object" || value === null || !Array.isArray(value)) {
    return null;
  }
  const rows = [];
  for (const entry of value) {
    const row = rowFromUnknown(entry);
    if (!row) return null;
    rows.push(row);
  }
  return rows;
}
async function readTopWidgetData(dir) {
  const base = dir ?? defaultStateDir2();
  const file = path2.join(base, "actsis-litellm", "state.json");
  let parsed;
  try {
    parsed = JSON.parse(await readFile2(file, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed;
  const rows = rowsFromUnknown(record.lastTopModels);
  if (!rows || rows.length === 0) return null;
  const refreshedAt = record.topRefreshedAt;
  if (typeof refreshedAt !== "number" || !Number.isFinite(refreshedAt)) {
    return null;
  }
  const windowLabel = typeof record.topWindowLabel === "string" && record.topWindowLabel ? record.topWindowLabel : TOP_WIDGET_WINDOW_LABEL;
  const totalSpend = typeof record.topTotalSpend === "number" && Number.isFinite(record.topTotalSpend) ? record.topTotalSpend : rows.reduce((sum, r) => sum + r.spend, 0);
  return { rows, windowLabel, totalSpend, refreshedAt };
}

// src/preferences.ts
import path3 from "path";
import { mkdir, readFile as readFile3, writeFile, rm } from "fs/promises";
import { renameSync } from "fs";
import os3 from "os";
var PREFS_SCHEMA_VERSION = 1;
var DEFAULT_APP_DIR_NAME = "opencode";
var DEFAULT_PLUGIN_DIR_NAME = "actsis-litellm";
var PREFS_FILE_NAME = "preferences.json";
function defaultPreferences() {
  return { version: PREFS_SCHEMA_VERSION, topModelsWidget: true };
}
function defaultPluginDir() {
  const dataHome = process.env.XDG_DATA_HOME ? process.env.XDG_DATA_HOME : path3.join(os3.homedir(), ".local", "share");
  return path3.join(dataHome, DEFAULT_APP_DIR_NAME, DEFAULT_PLUGIN_DIR_NAME);
}
function preferencesPath(dir) {
  return path3.join(dir ?? defaultPluginDir(), PREFS_FILE_NAME);
}
async function readPreferences(dir) {
  try {
    const raw = await readFile3(preferencesPath(dir), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return defaultPreferences();
    }
    const version = typeof parsed.version === "number" ? parsed.version : PREFS_SCHEMA_VERSION;
    if (version !== PREFS_SCHEMA_VERSION) {
      return defaultPreferences();
    }
    return {
      version: PREFS_SCHEMA_VERSION,
      topModelsWidget: typeof parsed.topModelsWidget === "boolean" ? parsed.topModelsWidget : defaultPreferences().topModelsWidget
    };
  } catch {
    return defaultPreferences();
  }
}
function readTopModelsWidgetEnabled(dir) {
  return readPreferences(dir).then((prefs) => prefs.topModelsWidget);
}

// src/widget-events.ts
var WIDGET_REFRESH_EVENT_TYPES = [
  "session.idle",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted"
];
var WIDGET_REFRESH_TRIGGER_SET = new Set(
  WIDGET_REFRESH_EVENT_TYPES
);

// src/tui.tsx
var IDLE_REFRESH_DEBOUNCE_MS = 2e3;
var tui_default = Plugin.define({
  id: "actsis-litellm-budget",
  async setup(context) {
    let data = null;
    let top = null;
    try {
      data = await readBudgetWidgetData();
      if (await readTopModelsWidgetEnabled()) {
        top = await readTopWidgetData();
      }
    } catch {
      data = null;
      top = null;
    }
    const [line, setLine] = createSignal(data ? budgetWidgetLine(data, Date.now()) : null);
    const [topLines, setTopLines] = createSignal(top ? topWidgetLines(top, Date.now()) : null);
    let timeout;
    const refresh = async () => {
      try {
        const next = await readBudgetWidgetData();
        setLine(next ? budgetWidgetLine(next, Date.now()) : null);
        const topData = await readTopWidgetData();
        setTopLines(await readTopModelsWidgetEnabled() && topData ? topWidgetLines(topData, Date.now()) : null);
      } catch {
        setLine(null);
        setTopLines(null);
      }
    };
    context.ui.slot({
      append: "sidebar.footer",
      render: (_input) => {
        return line() || topLines() ? (() => {
          var _el$ = _$createElement("box"), _el$2 = _$createElement("text");
          _$insertNode(_el$, _el$2);
          _$insert(_el$2, line);
          _$insert(_el$, (() => {
            var _c$ = _$memo(() => !!topLines());
            return () => _c$() && (() => {
              var _el$3 = _$createElement("text");
              _$insert(_el$3, () => topLines().join("\n"));
              return _el$3;
            })();
          })(), null);
          return _el$;
        })() : null;
      }
    });
    const unsubscribers = WIDGET_REFRESH_EVENT_TYPES.map((type) => context.data.on(type, () => {
      if (timeout !== void 0) clearTimeout(timeout);
      timeout = setTimeout(() => void refresh(), IDLE_REFRESH_DEBOUNCE_MS);
    }));
    void refresh();
    const pollTimer = setInterval(() => void refresh(), 6e4);
    return () => {
      for (const unsub of unsubscribers) unsub();
      if (timeout !== void 0) clearTimeout(timeout);
      clearInterval(pollTimer);
    };
  }
});
export {
  tui_default as default
};

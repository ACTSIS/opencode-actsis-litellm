/**
 * ANSI truecolor palette for the usage-style gauge thresholds, shared by the
 * /usage-subs table, the budget tool lines, and the budget status surface.
 * Mirrors the pi sibling's `extensions/lib/gauge-color.ts`. Sent only when the
 * caller opts in ({color: true}): tool output surfaces in opencode render
 * embedded SGR runs (proven by the usage_subs tool). Plain output stays
 * byte-identical when the option is omitted (test fixtures, surfaces without
 * ANSI guarantees).
 */
export const GAUGE_COLORS = {
  green: "38;2;34;197;94",
  yellow: "38;2;234;179;8",
  orange: "38;2;249;115;22",
  red: "38;2;239;68;68",
} as const;

/**
 * Same palette as hex, for OpenTUI widget surfaces that strip embedded SGR
 * and require styling through `<span fg>` props instead.
 */
export const GAUGE_HEX = {
  green: "#22c55e",
  yellow: "#eab308",
  orange: "#f97316",
  red: "#ef4444",
} as const;

export type GaugeColorName = keyof typeof GAUGE_COLORS;

/** Threshold bands over used%: <=50 green, 51-75 yellow, 76-90 orange, >90 red. */
export function gaugeColorName(usedPercent: number): GaugeColorName {
  return usedPercent <= 50 ? "green"
    : usedPercent <= 75 ? "yellow"
    : usedPercent <= 90 ? "orange"
    : "red";
}

/** Thresholds over used%: <=50 green, 51-75 yellow, 76-90 orange, >90 red. */
export function gaugeColorAnsi(usedPercent: number): string {
  return `\x1b[${GAUGE_COLORS[gaugeColorName(usedPercent)]}m`;
}

/** Hex form of the same thresholds, keyed for OpenTUI `<span fg>` styling. */
export function gaugeColorHex(usedPercent: number): string {
  return GAUGE_HEX[gaugeColorName(usedPercent)];
}

/**
 * End-of-run reset restoring dim + default fg: surfaces that wrap messages in
 * a dim run must not have a colored run end with a bare reset that clears the
 * wrapper.
 */
export const GAUGE_ANSI_RESET_DIM = "\x1b[2;39m";

/** End-of-run reset for surfaces without a dim wrapper. */
export const GAUGE_ANSI_RESET_FG = "\x1b[39m";
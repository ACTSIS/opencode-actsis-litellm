/**
 * Argument parsing for the `top` preference command (the
 * actsis-litellm-top command + actsis_litellm_top tool). Mirrors the sibling
 * pi extension's commands.ts port c03385b: empty = toggle, `on`/`off` set the
 * preference, anything else is an error.
 */

export interface ParsedTopPrefArg {
  state: "on" | "off";
  changed: boolean;
}

export function parseTopPrefArg(
  args: string | undefined | null,
  current: boolean,
): ParsedTopPrefArg | { error: string } {
  const trimmed = (args ?? "").trim().toLowerCase();
  if (trimmed === "") {
    const next = !current;
    return { state: next ? "on" : "off", changed: true };
  }
  if (trimmed === "on" || trimmed === "off") {
    const next = trimmed === "on";
    return { state: next ? "on" : "off", changed: next !== current };
  }
  return { error: "expected nothing (toggle), `on`, or `off`" };
}

/**
 * The tool answer for a successful toggle: `Top-5 widget: on (saved)` or
 * `... (already)` when nothing changed (ported answer strings).
 */
export function formatTopToggleAnswer(parsed: ParsedTopPrefArg): string {
  return `Top-5 widget: ${parsed.state}${parsed.changed ? " (saved)" : " (already)"}`;
}
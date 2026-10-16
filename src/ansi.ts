/**
 * SGR (ANSI color) parser for surfaces that cannot render embedded escape
 * sequences — the OpenCode chat transcript renders code blocks through a text
 * buffer that shows uninterpreted SGR literally, and chat storage strips the
 * ESC byte from assistant messages (verified against the message DB: tool
 * output relays arrive as ESC-less fragments like "[38;2;r;g;bm"). The plugin
 * registers a chat code-block renderer (language `ansi`, like opencode's
 * built-in latex and mermaid renderers) that feeds these runs into OpenTUI
 * TextNodes instead.
 *
 * Scope: only what the gateway surfaces emit — truecolor foreground
 * (`38;2;r;g;b`), full reset (0) and fg resets (39). Every other CSI/OSC
 * sequence is stripped so no escape bytes reach the render buffer; unsupported
 * SGR attributes are ignored (stripped, no styling) rather than guessed.
 */

export interface AnsiRun {
  text: string;
  /** Hex color of the run (`#rrggbb`), or undefined for plain text. */
  fg?: string;
}

const CSI_FINAL_MIN = 0x40;
const CSI_FINAL_MAX = 0x7e;
const PARAM_RE = /[\d;:]/;

/** Hex color for one SGR truecolor foreground sequence. */
function rgbHex(r: number, g: number, b: number): string | undefined {
  const channel = (c: number) =>
    c >= 0 && c <= 255 ? c.toString(16).padStart(2, "0") : undefined;
  const rr = channel(r);
  const gg = channel(g);
  const bb = channel(b);
  if (rr === undefined || gg === undefined || bb === undefined) return undefined;
  return `#${rr}${gg}${bb}`;
}

/**
 * Truecolor foreground parameter form: `38;2;r;g;b` (colons normalized to
 * semicolons). Applies the params to `state`, mutating only `state.fg`.
 */
function applySgr(params: string, state: { fg: string | undefined }): void {
  const parts = params
    .replaceAll(":", ";")
    .split(";")
    .map((part) => (part === "" ? 0 : Number.parseInt(part, 10)));
  for (let index = 0; index < parts.length; index += 1) {
    const param = parts[index]!;
    if (param === 0 || param === 39) {
      state.fg = undefined;
      continue;
    }
    if (param === 38) {
      const mode = parts[index + 1];
      if (mode === 2) {
        const color = rgbHex(
          parts[index + 2]!,
          parts[index + 3]!,
          parts[index + 4]!,
        );
        if (color !== undefined) state.fg = color;
        index += 4;
      } else if (mode === 5) {
        index += 2; // indexed palette (5;n): unsupported, consume and ignore
      }
      continue;
    }
    // Bold, dim, backgrounds, palettes, etc.: unsupported, strip without style.
  }
}

/**
 * True when text[index] is "[" followed by at least one digit/:/; param and a
 * letter final byte — the ESC-less SGR fragment shape chat storage produces.
 * Bracket text that is not this shape ("array[0]", "[x]", "[]") stays literal.
 */
function isFragmentCsiAt(input: string, index: number): boolean {
  let cursor = index + 1;
  while (cursor < input.length && PARAM_RE.test(input[cursor]!)) cursor += 1;
  if (cursor === index + 1 || cursor >= input.length) return false;
  const final = input[cursor]!;
  return (final >= "A" && final <= "Z") || (final >= "a" && final <= "z");
}

/** True when the byte is an ASCII letter (fragment CSI final byte). */
function isLetter(char: string): boolean {
  return (char >= "A" && char <= "Z") || (char >= "a" && char <= "z");
}

/**
 * Convert raw ANSI text into plain styled runs. Adjacent text between escape
 * sequences becomes exactly one run; runs carry the fg color active at the
 * point the text appears (undefined = default fg). Style-neutral sequences
 * never split the surrounding text. Both the ESC-prefixed CSI form and the
 * ESC-less fragment form (chat storage strips escape bytes) are recognized.
 */
export function parseAnsiRuns(input: string): AnsiRun[] {
  const runs: AnsiRun[] = [];
  const state = { fg: undefined as string | undefined };
  let text = "";
  const flush = () => {
    if (text.length > 0) {
      runs.push(state.fg === undefined ? { text } : { text, fg: state.fg });
      text = "";
    }
  };

  let index = 0;
  while (index < input.length) {
    const char = input[index]!;
    if (char === "\x1b") {
      const next = input[index + 1];
      if (next === "[") {
        let cursor = index + 2;
        while (
          cursor < input.length &&
          !(
            input.charCodeAt(cursor) >= CSI_FINAL_MIN &&
            input.charCodeAt(cursor) <= CSI_FINAL_MAX
          )
        ) {
          cursor += 1;
        }
        if (cursor >= input.length) {
          // Unterminated CSI: strip the rest of the input.
          break;
        }
        if (input[cursor] === "m") {
          // Flush the old-style text BEFORE the new style applies so the
          // preceding run keeps its own color.
          const temp = { fg: state.fg };
          applySgr(input.slice(index + 2, cursor), temp);
          if (temp.fg !== state.fg) flush();
          state.fg = temp.fg;
        }
        index = cursor + 1;
        continue;
      }
      if (next === "]") {
        // OSC: end at BEL or ST (ESC backslash), whichever comes first.
        const bel = input.indexOf("\x07", index + 2);
        const st = input.indexOf("\x1b\\", index + 2);
        let end: number;
        if (bel === -1 && st === -1) {
          end = input.length;
        } else if (bel === -1) {
          end = st + 2;
        } else if (st === -1) {
          end = bel + 1;
        } else {
          end = Math.min(bel + 1, st + 2);
        }
        index = Math.min(end, input.length);
        continue;
      }
      // Lone escape byte with a non-CSI/OSC follower (e.g. "a\<ESC>b"): drop
      // the escape byte only, so the surrounding text survives intact.
      index += 1;
      continue;
    }
    if (char === "[" && isFragmentCsiAt(input, index)) {
      let cursor = index + 1;
      while (cursor < input.length && PARAM_RE.test(input[cursor]!)) cursor += 1;
      const final = input[cursor];
      if (final === undefined) break;
      if (final === "m") {
        const temp = { fg: state.fg };
        applySgr(input.slice(index + 1, cursor), temp);
        if (temp.fg !== state.fg) flush();
        state.fg = temp.fg;
      } else if (isLetter(final)) {
        // Non-SGR fragment CSI with a letter final byte (e.g. cursor moves):
        // strip like the escaped form.
        index = cursor + 1;
        continue;
      }
      index = cursor + 1;
      continue;
    }
    text += char;
    index += 1;
  }
  flush();
  return runs;
}
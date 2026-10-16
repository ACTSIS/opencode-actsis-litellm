import { describe, expect, it } from "vitest";
import { parseAnsiRuns } from "../src/ansi.ts";
import {
  GAUGE_ANSI_RESET_FG,
  GAUGE_ANSI_RESET_DIM,
  GAUGE_COLORS,
} from "../src/gauge-color.ts";

const GREEN = `\x1b[${GAUGE_COLORS.green}m`;

describe("parseAnsiRuns", () => {
  it("returns an empty list for empty input", () => {
    expect(parseAnsiRuns("")).toEqual([]);
  });

  it("returns one uncolored run for plain text", () => {
    expect(parseAnsiRuns("hello world")).toEqual([{ text: "hello world" }]);
  });

  it("colors the run after a truecolor SGR sequence", () => {
    expect(parseAnsiRuns(`${GREEN}▰▰▱▱`)).toEqual([
      { text: "▰▰▱▱", fg: "#22c55e" },
    ]);
  });

  it("switches color on subsequent sequences and keeps plain text separated", () => {
    const red = `\x1b[${GAUGE_COLORS.red}m`;
    expect(parseAnsiRuns(`${GREEN}ok${red}bad`)).toEqual([
      { text: "ok", fg: "#22c55e" },
      { text: "bad", fg: "#ef4444" },
    ]);
  });

  it("handles the 39m fg reset back to plain text", () => {
    expect(parseAnsiRuns(`${GREEN}64%${GAUGE_ANSI_RESET_FG} · $1.00`)).toEqual([
      { text: "64%", fg: "#22c55e" },
      { text: " · $1.00" },
    ]);
  });

  it("handles the dim+fg reset sequence without styling anything", () => {
    expect(parseAnsiRuns(`${GREEN}64%${GAUGE_ANSI_RESET_DIM} rest`)).toEqual([
      { text: "64%", fg: "#22c55e" },
      { text: " rest" },
    ]);
  });

  it("handles the full reset (0m) back to plain text", () => {
    expect(parseAnsiRuns(`${GREEN}▓\x1b[0m plain`)).toEqual([
      { text: "▓", fg: "#22c55e" },
      { text: " plain" },
    ]);
  });

  it("ignores unknown SGR attrs (bold) while stripping their sequences", () => {
    expect(parseAnsiRuns("\x1b[1mheader\x1b[22m")).toEqual([{ text: "header" }]);
  });

  it("strips non-SGR CSI sequences, keeping surrounding text", () => {
    expect(parseAnsiRuns(`a\x1b[2Jb\x1b[5c`)).toEqual([{ text: "ab" }]);
  });

  it("strips OSC sequences including hyperlinks", () => {
    expect(
      parseAnsiRuns(`a\x1b]8;;https://x.example\x07link\x1b]8;;\x07b`),
    ).toEqual([{ text: "alinkb" }]);
  });

  it("strips a lone ESC character", () => {
    expect(parseAnsiRuns("a\x1bb")).toEqual([{ text: "ab" }]);
  });

  it("colors runs from ESC-less SGR fragments (chat storage strips escape bytes)", () => {
    const fragment =
      "0    [38;2;34;197;94m▰▰▱▱ 27% 1,029 reqs[2;39m        1 h 3 min";
    expect(parseAnsiRuns(fragment)).toEqual([
      { text: "0    " },
      { text: "▰▰▱▱ 27% 1,029 reqs", fg: "#22c55e" },
      { text: "        1 h 3 min" },
    ]);
  });

  it("honors fragment fg reset and full reset", () => {
    expect(parseAnsiRuns("[38;2;239;68;68mhigh[39m rest")).toEqual([
      { text: "high", fg: "#ef4444" },
      { text: " rest" },
    ]);
    expect(parseAnsiRuns("[38;2;234;179;8mmed[0m rest")).toEqual([
      { text: "med", fg: "#eab308" },
      { text: " rest" },
    ]);
  });

  it("strips ESC-less non-SGR CSI fragments with letter finals", () => {
    expect(parseAnsiRuns("a[5Ab")).toEqual([{ text: "ab" }]);
  });

  it("keeps bracket text that is not an SGR fragment", () => {
    expect(parseAnsiRuns("array[0] and [x] and []")).toEqual([
      { text: "array[0] and [x] and []" },
    ]);
  });

  it("colors the exact ESC-less relay stored by chat (message DB, 2026-10-16 15:57)", () => {
    const stored =
      "Usage subscriptions (generated at 2026-10-16 15:57 (America/Bogota, GMT-05:00)):\n" +
      "Sub  5h used                        5h resets in  Weekly used                     Weekly resets in  Credits\n" +
      "-----------------------------------------------------------------------------------------------------------\n" +
      "0    [38;2;34;197;94m▰▰▱▱▱▱▱▱ 27% 1,029 reqs[2;39m        1 h 3 min     [38;2;234;179;8m▰▰▰▰▰▱▱▱ 58% 12,546 reqs[2;39m        2 d 4 h           purchased $0.00\n";
    expect(parseAnsiRuns(stored)).toEqual([
      {
        text:
          "Usage subscriptions (generated at 2026-10-16 15:57 (America/Bogota, GMT-05:00)):\n" +
          "Sub  5h used                        5h resets in  Weekly used                     Weekly resets in  Credits\n" +
          "-----------------------------------------------------------------------------------------------------------\n" +
          "0    ",
      },
      { text: "▰▰▱▱▱▱▱▱ 27% 1,029 reqs", fg: "#22c55e" },
      { text: "        1 h 3 min     " },
      { text: "▰▰▰▰▰▱▱▱ 58% 12,546 reqs", fg: "#eab308" },
      { text: "        2 d 4 h           purchased $0.00\n" },
    ]);
  });

  it("accepts colon-separated SGR params like 38:2:r:g:b", () => {
    expect(parseAnsiRuns("\x1b[38:2:34:197:94mrun")).toEqual([
      { text: "run", fg: "#22c55e" },
    ]);
  });

  it("ignores unsupported param forms (indexed 256-color, background)", () => {
    expect(parseAnsiRuns("\x1b[38;5;208mc\x1b[48;2;1;2;3mb")).toEqual([
      { text: "cb" },
    ]);
  });

  it("never leaves escape bytes or CSI fragments in run text", () => {
    const sample =
      "Sub usage table\r\n" +
      `${GREEN}▰▰▱▱ 19%\x1b[0m plain\n` +
      `\x1b[?25l\x1b[38;5;196mx`;
    for (const run of parseAnsiRuns(sample)) {
      expect(run.text).not.toMatch(/\x1b/);
      expect(run.text).not.toMatch(/\[3[89];/);
      expect(run.text).not.toMatch(/\x9b/);
    }
  });
});
import { describe, expect, it } from "vitest";
import {
  LITELLM_OVERFLOW_PATTERN,
  isOverflowErrorMessage,
} from "../src/overflow.ts";

describe("isOverflowErrorMessage", () => {
  const phrases = [
    "maximum context length exceeded",
    "the context window is too small",
    "context_length_exceeded",
    "input is too long for this model",
    "prompt is too long",
    "too many input tokens",
    "requested tokens exceed context limit",
    "please reduce the length of the messages",
  ];

  it.each(phrases)("matches overflow phrase: %s", (phrase) => {
    expect(isOverflowErrorMessage(phrase)).toBe(true);
    expect(isOverflowErrorMessage(phrase.toUpperCase())).toBe(true);
  });

  it("does not match rate-limit phrases", () => {
    expect(isOverflowErrorMessage("rate limit exceeded")).toBe(false);
    expect(isOverflowErrorMessage("too many requests")).toBe(false);
    expect(isOverflowErrorMessage("throttled by provider")).toBe(false);
  });

  it("returns false for empty or missing input", () => {
    expect(isOverflowErrorMessage("")).toBe(false);
    expect(isOverflowErrorMessage(undefined)).toBe(false);
  });

  it("exposes the expected pattern as a RegExp", () => {
    expect(LITELLM_OVERFLOW_PATTERN).toBeInstanceOf(RegExp);
    expect(LITELLM_OVERFLOW_PATTERN.flags).toContain("i");
  });
});

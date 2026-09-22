/**
 * LiteLLM/upstream context-window overflow phrase detector.
 *
 * Matches overflow phrases commonly surfaced through LiteLLM proxy error bodies
 * when the upstream rejects a request for exceeding the model's context window.
 * Intentionally excludes rate-limit / throttling phrases so those stay on
 * OpenCode's normal retry-with-backoff path.
 */
export const LITELLM_OVERFLOW_PATTERN: RegExp = new RegExp(
  [
    "maximum context length",
    "context window",
    "context_length_exceeded",
    "input is too long",
    "prompt is too long",
    "too many input tokens",
    "requested tokens exceed",
    "reduce the length",
  ].join("|"),
  "i",
);

/**
 * Safe overflow phrase check.
 */
export function isOverflowErrorMessage(message: string | undefined): boolean {
  if (!message) return false;
  return LITELLM_OVERFLOW_PATTERN.test(message);
}

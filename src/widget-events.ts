/**
 * Event types that should trigger a budget/top-5 widget refresh.
 *
 * opencode v2 emits `session.execution.{succeeded,failed,interrupted}` and no
 * longer publishes the deprecated `session.idle`; the idle type is kept here
 * for forward compatibility (and older hosts) so the refresh triggers cover
 * the full event inventory.
 */
export const WIDGET_REFRESH_EVENT_TYPES = [
  "session.idle",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
] as const;

export type WidgetRefreshEventType = (typeof WIDGET_REFRESH_EVENT_TYPES)[number];

const WIDGET_REFRESH_TRIGGER_SET: ReadonlySet<string> = new Set(
  WIDGET_REFRESH_EVENT_TYPES,
);

export function isWidgetRefreshTrigger(type: string): boolean {
  return WIDGET_REFRESH_TRIGGER_SET.has(type);
}
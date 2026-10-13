import { describe, it, expect } from "vitest";
import {
  WIDGET_REFRESH_EVENT_TYPES,
  isWidgetRefreshTrigger,
} from "../src/widget-events.ts";

describe("widget refresh event types", () => {
  it("the tuple contains exactly the four refresh triggers", () => {
    expect([...WIDGET_REFRESH_EVENT_TYPES]).toEqual([
      "session.idle",
      "session.execution.succeeded",
      "session.execution.failed",
      "session.execution.interrupted",
    ]);
  });

  it("isWidgetRefreshTrigger accepts each trigger type", () => {
    for (const type of WIDGET_REFRESH_EVENT_TYPES) {
      expect(isWidgetRefreshTrigger(type)).toBe(true);
    }
  });

  it("isWidgetRefreshTrigger rejects unrelated event types", () => {
    for (const type of ["session.status", "message.part.updated", "session.created"]) {
      expect(isWidgetRefreshTrigger(type)).toBe(false);
    }
  });
});
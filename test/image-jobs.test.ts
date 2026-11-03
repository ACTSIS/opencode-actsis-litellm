import { describe, it, expect } from "vitest";
import {
  ImageJobRegistry,
  MAX_CONCURRENT_IMAGE_JOBS,
} from "../src/image-jobs.ts";

describe("ImageJobRegistry", () => {
  it("creates a queued job with its own abort controller (S7)", () => {
    const registry = new ImageJobRegistry();
    const first = registry.create("sdxl-pixel-art", "512x512", "ses-1");
    const second = registry.create("qwen-image-edit", "1024x1024", "ses-1");

    expect(first.id).toBe("img-1");
    expect(second.id).toBe("img-2");
    expect(first.status).toBe("queued");
    expect(first.model).toBe("sdxl-pixel-art");
    expect(first.size).toBe("512x512");
    expect(first.sessionID).toBe("ses-1");
    expect(first.controller).not.toBe(second.controller);
    expect(first.controller.signal.aborted).toBe(false);
  });

  it("refuses a third concurrent job and names the running ids (S11)", () => {
    const registry = new ImageJobRegistry();
    const first = registry.create("sdxl-pixel-art", "512x512", "ses-1");
    const second = registry.create("sdxl-pixel-art", "512x512", "ses-1");
    registry.start(first.id);
    registry.start(second.id);

    expect(MAX_CONCURRENT_IMAGE_JOBS).toBe(2);
    expect(() => registry.create("sdxl-pixel-art", "512x512", "ses-1")).toThrow(
      /Too many concurrent image renders \(2\/2\)/,
    );
    expect(() => registry.create("sdxl-pixel-art", "512x512", "ses-1")).toThrow(
      new RegExp(`${first.id}, ${second.id}`),
    );
  });

  it("frees the slot once a job settles (S11)", () => {
    const registry = new ImageJobRegistry();
    const first = registry.create("sdxl-pixel-art", "512x512", "ses-1");
    const second = registry.create("sdxl-pixel-art", "512x512", "ses-1");
    registry.start(first.id);
    registry.start(second.id);
    registry.settle(first.id, "done");
    registry.remove(first.id);

    expect(() => registry.create("sdxl-pixel-art", "512x512", "ses-1")).not.toThrow();
  });

  it("cancels one active job and aborts its controller (S8)", () => {
    const registry = new ImageJobRegistry();
    const job = registry.create("sdxl-pixel-art", "512x512", "ses-1");
    registry.start(job.id);

    const cancelled = registry.cancel(job.id);

    expect(cancelled?.id).toBe(job.id);
    expect(job.status).toBe("cancelled");
    expect(job.controller.signal.aborted).toBe(true);
    expect(registry.cancel(job.id)).toBeUndefined();
    expect(registry.cancel("img-404")).toBeUndefined();
  });

  it("cancelAll aborts every active job once and reports the ids (S10)", () => {
    const registry = new ImageJobRegistry();
    const first = registry.create("sdxl-pixel-art", "512x512", "ses-1");
    const second = registry.create("sdxl-pixel-art", "512x512", "ses-2");
    registry.start(first.id);
    registry.settle(second.id, "done");

    expect(registry.cancelAll()).toEqual([first.id]);
    expect(first.controller.signal.aborted).toBe(true);
    expect(second.controller.signal.aborted).toBe(false);
    // Idempotent: a second shutdown pass has nothing left to abort.
    expect(registry.cancelAll()).toEqual([]);
  });

  it("separates running, active and finished jobs", () => {
    const registry = new ImageJobRegistry();
    const running = registry.create("a", "512x512", "ses-1");
    const queued = registry.create("b", "512x512", "ses-1");
    const done = registry.create("c", "512x512", "ses-1");
    registry.start(running.id);
    registry.settle(done.id, "done");

    expect(registry.running().map((j) => j.id)).toEqual([running.id]);
    expect(registry.active().map((j) => j.id).sort()).toEqual(
      [running.id, queued.id].sort(),
    );
    expect(registry.list()).toHaveLength(3);
  });

  it("describes elapsed time for the status listing (S8)", () => {
    const registry = new ImageJobRegistry();
    const job = registry.create("sdxl-pixel-art", "512x512", "ses-1");
    registry.start(job.id);
    job.startedAt = Date.now() - 3_000;

    const [line] = registry.describeActive();
    expect(line).toMatch(new RegExp(`^${job.id}: sdxl-pixel-art 512x512 running \\(\\d+s\\)$`));
  });
});

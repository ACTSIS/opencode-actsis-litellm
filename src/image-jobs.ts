/**
 * Detached image render jobs (port of pi #61 S1-S11 to the OpenCode v2 plugin
 * API). The gateway renders on a single GPU, so jobs are capped and each one
 * owns its own AbortController: the tool-call signal belongs to the active turn
 * and must never be reused after `execute` returns.
 */

export type ImageJobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface ImageJob {
  id: string;
  model: string;
  size: string;
  /** Session that asked for the render; delivery is aimed at it. */
  sessionID: string;
  status: ImageJobStatus;
  startedAt: number;
  controller: AbortController;
}

export const MAX_CONCURRENT_IMAGE_JOBS = 2;

export class ImageJobRegistry {
  private jobs = new Map<string, ImageJob>();
  private counter = 0;

  get size(): number {
    return this.jobs.size;
  }

  create(model: string, size: string, sessionID: string): ImageJob {
    const running = this.running();
    if (running.length >= MAX_CONCURRENT_IMAGE_JOBS) {
      throw new Error(
        `Too many concurrent image renders (${running.length}/${MAX_CONCURRENT_IMAGE_JOBS}). ` +
          `Running jobs: ${running.map((j) => j.id).join(", ")}. ` +
          `Wait for one to finish or cancel it with the actsis_litellm_cancel_image tool.`,
      );
    }
    const id = `img-${++this.counter}`;
    const job: ImageJob = {
      id,
      model,
      size,
      sessionID,
      status: "queued",
      startedAt: Date.now(),
      controller: new AbortController(),
    };
    this.jobs.set(id, job);
    return job;
  }

  get(id: string): ImageJob | undefined {
    return this.jobs.get(id);
  }

  list(): ImageJob[] {
    return Array.from(this.jobs.values());
  }

  running(): ImageJob[] {
    return this.list().filter((j) => j.status === "running");
  }

  active(): ImageJob[] {
    return this.list().filter((j) => j.status === "queued" || j.status === "running");
  }

  /** Active jobs of one session — the scope of the pending-`last` guard (S9). */
  activeForSession(sessionID: string): ImageJob[] {
    return this.active().filter((j) => j.sessionID === sessionID);
  }

  start(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== "queued") return false;
    job.status = "running";
    return true;
  }

  settle(id: string, status: "done" | "failed" | "cancelled"): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.status = status;
    return true;
  }

  remove(id: string): boolean {
    return this.jobs.delete(id);
  }

  cancel(id: string): ImageJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.status === "done" || job.status === "failed" || job.status === "cancelled") {
      return undefined;
    }
    job.status = "cancelled";
    job.controller.abort();
    return job;
  }

  cancelAll(): string[] {
    const ids: string[] = [];
    for (const job of this.active()) {
      if (this.cancel(job.id)) ids.push(job.id);
    }
    return ids;
  }

  /** `id: model size status (Ns)` lines; the status line pi paints via ui.setStatus. */
  describeActive(): string[] {
    return this.active().map((job) => {
      const elapsed = Math.floor((Date.now() - job.startedAt) / 1000);
      return `${job.id}: ${job.model} ${job.size} ${job.status} (${elapsed}s)`;
    });
  }
}

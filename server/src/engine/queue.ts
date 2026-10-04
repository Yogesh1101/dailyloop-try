import { RunModel } from '../db/models';
import type { PipelineRunner } from './runner';
import { getSettings } from './settings';

/** Single-process work queue: claims queued runs whose time has come and drives them. */
export class RunWorker {
  private active = new Map<string, AbortController>();
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(private runner: PipelineRunner) {}

  start(intervalMs: number) {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    for (const ac of this.active.values()) ac.abort();
  }

  isActive(runId: string) {
    return this.active.has(runId);
  }

  /** A run left "running" by a crash or restart cannot be trusted: block it for a human. */
  async recover(): Promise<number> {
    const stuck = await RunModel.find({ status: 'running' }).lean();
    for (const run of stuck) {
      const stages = run.stages as any[];
      const s = stages[run.currentStage ?? 0];
      if (s && ['running', 'gating'].includes(s.status)) {
        s.status = 'blocked';
        s.error = 'Interrupted by a server restart. Retry the stage to continue.';
      }
      await RunModel.updateOne(
        { _id: run._id },
        { $set: { status: 'blocked', statusMessage: 'Interrupted by a server restart', stages } },
      );
    }
    return stuck.length;
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const { maxConcurrentRuns } = await getSettings();
      while (this.active.size < maxConcurrentRuns) {
        const now = new Date();
        const run = await RunModel.findOneAndUpdate(
          { status: 'queued', $or: [{ scheduledFor: null }, { scheduledFor: { $lte: now } }] },
          { $set: { status: 'running', statusMessage: 'Starting' } },
          { sort: { scheduledFor: 1, createdAt: 1 }, returnDocument: 'after' },
        ).lean();
        if (!run) break;
        const id = String(run._id);
        const ac = new AbortController();
        this.active.set(id, ac);
        void this.runner
          .execute(id, ac.signal)
          .catch((e) => console.error(`[worker] run ${id} crashed`, e))
          .finally(() => this.active.delete(id));
      }
    } catch (e) {
      console.error('[worker] tick failed', e);
    } finally {
      this.ticking = false;
    }
  }

  cancel(runId: string): boolean {
    const ac = this.active.get(runId);
    if (!ac) return false;
    ac.abort();
    return true;
  }
}

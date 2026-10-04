import { Cron } from 'croner';
import { ScheduleModel } from '../db/models';
import type { RunActions } from '../engine/actions';

/** Cron-driven runs ("24-hour sprint": queue work for overnight execution). */
export class Scheduler {
  private jobs = new Map<string, Cron>();

  constructor(private actions: RunActions) {}

  static validate(expr: string): Date | null {
    const c = new Cron(expr, { paused: true });
    const next = c.nextRun();
    c.stop();
    return next;
  }

  static nextRun(expr: string): Date | null {
    try {
      return Scheduler.validate(expr);
    } catch {
      return null;
    }
  }

  async reload() {
    for (const j of this.jobs.values()) j.stop();
    this.jobs.clear();
    const schedules = await ScheduleModel.find({ enabled: true }).lean();
    for (const s of schedules) {
      const id = String(s._id);
      try {
        this.jobs.set(id, new Cron(s.cron, { name: `schedule-${id}`, protect: true }, () => void this.fire(id)));
      } catch (e) {
        await ScheduleModel.updateOne({ _id: s._id }, { $set: { lastError: `Invalid cron: ${(e as Error).message}` } });
      }
    }
  }

  async fire(id: string) {
    const s = await ScheduleModel.findById(id).lean();
    if (!s) return;
    try {
      const run = await this.actions.create(
        { repoId: s.repoId, pipelineId: s.pipelineId, task: s.task, title: `${s.name} — ${new Date().toLocaleDateString()}`, when: 'now' },
        id,
      );
      await ScheduleModel.updateOne({ _id: s._id }, { $set: { lastRunAt: new Date(), lastRunId: String(run._id), lastError: null } });
      return run;
    } catch (e) {
      await ScheduleModel.updateOne({ _id: s._id }, { $set: { lastRunAt: new Date(), lastError: (e as Error).message } });
      throw e;
    }
  }

  stop() {
    for (const j of this.jobs.values()) j.stop();
  }
}

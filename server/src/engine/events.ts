import { EventEmitter } from 'node:events';
import type { RunEvent, RunEventKind } from '@harness/shared';
import { RunEventModel } from '../db/models';

export type BusMessage = { type: 'event'; event: RunEvent } | { type: 'run'; runId: string };

function compact(data: unknown): unknown {
  if (data === undefined) return undefined;
  const s = typeof data === 'string' ? data : JSON.stringify(data);
  if (s.length <= 6000) return data;
  return `${s.slice(0, 6000)}… [${s.length - 6000} more characters]`;
}

/** Persists the run audit log and fans it out to live subscribers (SSE). */
export class EventBus {
  private em = new EventEmitter();

  constructor() {
    this.em.setMaxListeners(0);
  }

  async emit(
    runId: string,
    stageIndex: number | null,
    kind: RunEventKind,
    message: string,
    opts: { level?: RunEvent['level']; data?: unknown } = {},
  ): Promise<void> {
    const event: RunEvent = {
      runId,
      stageIndex,
      kind,
      level: opts.level ?? 'info',
      message: message.length > 4000 ? `${message.slice(0, 4000)}…` : message,
      data: compact(opts.data),
      ts: new Date().toISOString(),
    };
    try {
      const doc = await RunEventModel.create({ ...event, ts: new Date(event.ts) });
      event._id = String(doc._id);
    } catch (e) {
      console.error('[events] failed to persist event', e);
    }
    this.em.emit(runId, { type: 'event', event } satisfies BusMessage);
  }

  runChanged(runId: string) {
    const msg: BusMessage = { type: 'run', runId };
    this.em.emit(runId, msg);
    this.em.emit('*', msg);
  }

  subscribe(channel: string, fn: (m: BusMessage) => void): () => void {
    this.em.on(channel, fn);
    return () => this.em.off(channel, fn);
  }
}

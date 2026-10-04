import type { RunActions } from '../engine/actions';
import type { EventBus } from '../engine/events';
import type { RunWorker } from '../engine/queue';
import type { PipelineRunner } from '../engine/runner';
import type { ProviderRegistry } from '../providers/registry';
import type { Scheduler } from '../scheduler';

export interface AppContext {
  providers: ProviderRegistry;
  bus: EventBus;
  runner: PipelineRunner;
  worker: RunWorker;
  actions: RunActions;
  scheduler: Scheduler;
}

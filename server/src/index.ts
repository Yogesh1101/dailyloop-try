import fs from 'node:fs';
import { config } from './config';
import { connectDb } from './db/models';
import { seedDefaults } from './db/seed';
import { createApp } from './app';
import { RunActions } from './engine/actions';
import { EventBus } from './engine/events';
import { RunWorker } from './engine/queue';
import { PipelineRunner } from './engine/runner';
import { ProviderRegistry } from './providers/registry';
import { Scheduler } from './scheduler';

async function main() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  await connectDb(config.mongoUri);
  const seeded = await seedDefaults();
  console.log(`[harness] database ready; seeded ${seeded.skills} skills, ${seeded.operations} operations, ${seeded.pipelines} pipelines`);

  const providers = new ProviderRegistry();
  const bus = new EventBus();
  const runner = new PipelineRunner(providers, bus);
  const worker = new RunWorker(runner);
  const actions = new RunActions(runner, worker, bus);
  const scheduler = new Scheduler(actions);

  const recovered = await worker.recover();
  if (recovered) console.log(`[harness] ${recovered} interrupted run(s) blocked for review`);
  await scheduler.reload();
  worker.start(config.workerIntervalMs);

  const app = createApp({ providers, bus, runner, worker, actions, scheduler });
  const server = app.listen(config.port, config.host, () => {
    console.log(`[harness] API on http://${config.host}:${config.port}  (data: ${config.dataDir})`);
    for (const p of providers.list()) console.log(`[harness] provider ${p.id}: ${p.isConfigured() ? 'configured' : 'not configured'}`);
  });

  const shutdown = () => {
    console.log('[harness] shutting down');
    scheduler.stop();
    worker.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('[harness] failed to start:', e);
  process.exit(1);
});

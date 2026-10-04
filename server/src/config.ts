import path from 'node:path';

const root = path.resolve(process.cwd(), process.cwd().endsWith('server') ? '..' : '.');

export const config = {
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? '127.0.0.1',
  mongoUri: process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/agentic-harness',
  dataDir: path.resolve(root, process.env.DATA_DIR ?? './data'),
  clientDist: path.resolve(root, 'client/dist'),
  workerIntervalMs: Number(process.env.WORKER_INTERVAL_MS ?? 2000),
};

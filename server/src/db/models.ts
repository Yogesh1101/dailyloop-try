import mongoose, { Schema } from 'mongoose';

/*
 * Complex nested config (policies, gates, contracts, stages) is stored as Mixed and
 * validated with the shared zod schemas at the API boundary: one source of truth.
 */
const Mixed = Schema.Types.Mixed;
const opts = { timestamps: true, minimize: false } as const;

const RepoSchema = new Schema(
  {
    name: { type: String, required: true },
    description: { type: String, default: '' },
    source: { type: String, enum: ['local', 'git'], required: true },
    localPath: String,
    gitUrl: String,
    authTokenEnv: String,
    defaultBranch: { type: String, default: 'main' },
    checks: { type: Mixed, default: {} },
    lastSyncedAt: Date,
    lastError: String,
  },
  opts,
);

const SkillSchema = new Schema(
  {
    slug: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    description: { type: String, required: true },
    instructions: { type: String, required: true },
    tags: { type: [String], default: [] },
    builtIn: { type: Boolean, default: false },
  },
  opts,
);

const OperationSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    description: { type: String, default: '' },
    instructions: { type: String, required: true },
    skills: { type: [String], default: [] },
    provider: { type: String, default: 'anthropic' },
    model: { type: String, default: 'claude-opus-5-5' },
    effort: { type: String, default: 'high' },
    policy: { type: Mixed, required: true },
    inputs: { type: Mixed, default: [] },
    artifacts: { type: Mixed, default: [] },
    gates: { type: Mixed, default: [] },
    maxAttempts: { type: Number, default: 3 },
    rewindTo: String,
    maxRewinds: { type: Number, default: 2 },
    postActions: { type: Mixed, default: {} },
    builtIn: { type: Boolean, default: false },
  },
  opts,
);

const PipelineSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    description: { type: String, default: '' },
    constitution: { type: String, default: '' },
    globalPolicy: { type: Mixed, default: {} },
    stages: { type: Mixed, required: true },
    maxRunCostUsd: { type: Number, default: 25 },
    captureKnowledge: { type: Boolean, default: true },
    builtIn: { type: Boolean, default: false },
  },
  opts,
);

const usageShape = {
  inputTokens: { type: Number, default: 0 },
  outputTokens: { type: Number, default: 0 },
  cacheReadTokens: { type: Number, default: 0 },
  cacheWriteTokens: { type: Number, default: 0 },
  costUsd: { type: Number, default: 0 },
};

const RunSchema = new Schema(
  {
    title: { type: String, required: true },
    task: { type: String, required: true },
    repoId: { type: String, required: true, index: true },
    repoName: { type: String, required: true },
    pipeline: { type: Mixed, required: true },
    status: { type: String, required: true, index: true },
    statusMessage: String,
    currentStage: { type: Number, default: 0 },
    stages: { type: Mixed, required: true },
    branch: String,
    baseBranch: String,
    baseCommit: String,
    worktreePath: String,
    pullRequestUrl: String,
    scheduledFor: Date,
    scheduleId: String,
    usage: { type: usageShape, default: () => ({}) },
    humanNotes: { type: Mixed, default: [] },
    startedAt: Date,
    finishedAt: Date,
  },
  opts,
);

const RunEventSchema = new Schema({
  runId: { type: String, required: true, index: true },
  stageIndex: { type: Number, default: null },
  kind: { type: String, required: true },
  level: { type: String, default: 'info' },
  message: { type: String, required: true },
  data: Mixed,
  ts: { type: Date, default: Date.now, index: true },
});

const KnowledgeSchema = new Schema(
  {
    repoId: { type: String, default: null, index: true },
    type: { type: String, required: true },
    title: { type: String, required: true },
    content: { type: String, required: true },
    tags: { type: [String], default: [] },
    pinned: { type: Boolean, default: false },
    source: { type: String, default: 'manual' },
    runId: String,
  },
  opts,
);

const ScheduleSchema = new Schema(
  {
    name: { type: String, required: true },
    repoId: { type: String, required: true },
    pipelineId: { type: String, required: true },
    task: { type: String, required: true },
    cron: { type: String, required: true },
    enabled: { type: Boolean, default: true },
    lastRunAt: Date,
    lastRunId: String,
    lastError: String,
  },
  opts,
);

const SettingsSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    monthlyBudgetUsd: { type: Number, default: 200 },
    nightlyStartTime: { type: String, default: '22:00' },
    maxConcurrentRuns: { type: Number, default: 1 },
    models: { type: Mixed, default: [] },
  },
  opts,
);

/** One row per model turn: the source for cost dashboards and monthly budget gates. */
const UsageRecordSchema = new Schema({
  ts: { type: Date, default: Date.now, index: true },
  runId: { type: String, index: true },
  repoId: String,
  repoName: String,
  pipelineKey: String,
  operationKey: String,
  provider: String,
  model: String,
  inputTokens: Number,
  outputTokens: Number,
  cacheReadTokens: Number,
  cacheWriteTokens: Number,
  costUsd: Number,
});

export const RepoModel = mongoose.model('Repo', RepoSchema);
export const SkillModel = mongoose.model('Skill', SkillSchema);
export const OperationModel = mongoose.model('Operation', OperationSchema);
export const PipelineModel = mongoose.model('Pipeline', PipelineSchema);
export const RunModel = mongoose.model('Run', RunSchema);
export const RunEventModel = mongoose.model('RunEvent', RunEventSchema);
export const KnowledgeModel = mongoose.model('Knowledge', KnowledgeSchema);
export const ScheduleModel = mongoose.model('Schedule', ScheduleSchema);
export const SettingsModel = mongoose.model('Settings', SettingsSchema);
export const UsageRecordModel = mongoose.model('UsageRecord', UsageRecordSchema);

export async function connectDb(uri: string) {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
}

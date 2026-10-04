import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*  Primitives                                                                */
/* -------------------------------------------------------------------------- */

export const slug = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/, 'lowercase letters, digits and dashes; must start with a letter');

export const TOOL_NAMES = [
  'read_file',
  'list_dir',
  'search',
  'write_file',
  'edit_file',
  'run_command',
  'finish',
] as const;
export const ToolNameSchema = z.enum(TOOL_NAMES);
export type ToolName = z.infer<typeof ToolNameSchema>;

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const EffortSchema = z.enum(EFFORTS);
export type Effort = z.infer<typeof EffortSchema>;

/* -------------------------------------------------------------------------- */
/*  Policy guardrails                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Hard guardrails enforced on every tool call the agent makes.
 * Any violation halts the stage immediately and blocks the run.
 * Paths are globs relative to the run's worktree; `{{artifactsDir}}` expands to
 * the run's artifact folder.
 */
export const PolicySchema = z.object({
  allowedTools: z.array(ToolNameSchema).default(['read_file', 'list_dir', 'search', 'finish']),
  /** Globs the agent may create/modify. Anything else is read-only. */
  writablePaths: z.array(z.string()).default([]),
  /** Globs the agent may neither read nor write (secrets, VCS internals...). */
  forbiddenPaths: z.array(z.string()).default([]),
  /** Regexes; when non-empty a command must match at least one. */
  commandAllowlist: z.array(z.string()).default([]),
  /** Regexes; a matching command is a violation. */
  commandDenylist: z.array(z.string()).default([]),
  maxTurns: z.number().int().min(1).max(500).default(40),
  /** Total tokens (input + output) for the stage across all attempts. */
  maxTokens: z.number().int().min(1000).default(1_500_000),
  maxCostUsd: z.number().min(0.01).default(5),
  timeoutMinutes: z.number().min(1).max(24 * 60).default(45),
  commandTimeoutSeconds: z.number().int().min(5).max(3600).default(300),
});
export type Policy = z.infer<typeof PolicySchema>;

/** Pipeline-level guardrails. They are ADDED to every stage and can never be relaxed by an operation. */
export const GlobalPolicySchema = z.object({
  forbiddenPaths: z.array(z.string()).default([]),
  commandDenylist: z.array(z.string()).default([]),
});
export type GlobalPolicy = z.infer<typeof GlobalPolicySchema>;

/* -------------------------------------------------------------------------- */
/*  Artifact contracts                                                        */
/* -------------------------------------------------------------------------- */

export const ArtifactContractSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/, 'lowercase id'),
  /** File path relative to the run's artifacts dir, e.g. `spec.md`. */
  path: z.string().min(1),
  format: z.enum(['markdown', 'json']),
  description: z.string().default(''),
  /** Markdown: headings (any level) that must exist, matched case-insensitively. */
  requiredHeadings: z.array(z.string()).default([]),
  /** Regexes that must match somewhere in the file. */
  requiredPatterns: z
    .array(z.object({ pattern: z.string(), description: z.string() }))
    .default([]),
  minChars: z.number().int().min(0).default(0),
  /** Markdown: fail when the file contains TODO / TBD / FIXME / lorem ipsum. */
  rejectPlaceholders: z.boolean().default(true),
  /** JSON: JSON Schema (draft-07 subset supported by Ajv). */
  jsonSchema: z.record(z.string(), z.any()).optional(),
  /** Save the final, approved artifact to the repo knowledge base. */
  captureToKnowledge: z.boolean().default(false),
});
export type ArtifactContract = z.infer<typeof ArtifactContractSchema>;

/* -------------------------------------------------------------------------- */
/*  Gates                                                                     */
/* -------------------------------------------------------------------------- */

export const GATE_TYPES = ['artifacts', 'command', 'diff_scope', 'json_assert', 'human_approval'] as const;
export type GateType = (typeof GATE_TYPES)[number];

const gateBase = {
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/, 'lowercase id'),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  /**
   * retry  - feed the failure back to the agent and try again (up to maxAttempts)
   * rewind - send the failure back to the stage named by the operation's `rewindTo`
   * halt   - stop and block the run for a human
   */
  onFail: z.enum(['retry', 'rewind', 'halt']).default('retry'),
};

export const ArtifactsGateSchema = z.object({ ...gateBase, type: z.literal('artifacts') });

export const CommandGateSchema = z.object({
  ...gateBase,
  type: z.literal('command'),
  /** Name of a check configured on the repo (test, lint, typecheck, build...). */
  check: z.string().optional(),
  /** Literal shell command. Used when `check` is empty. */
  command: z.string().optional(),
  /**
   * When the repo has no check with this name: required=true fails the gate,
   * required=false skips it (recorded as skipped).
   */
  required: z.boolean().default(true),
  timeoutSeconds: z.number().int().min(5).max(7200).default(600),
  expectExitCode: z.number().int().default(0),
});

export const DiffScopeGateSchema = z.object({
  ...gateBase,
  type: z.literal('diff_scope'),
  /** Artifact id (produced by an earlier stage) holding the approved file list. */
  planArtifact: z.string().default('plan_json'),
  /** Path into the JSON artifact. `[]` flattens arrays, e.g. `tasks[].files`. */
  filesPath: z.string().default('tasks[].files'),
  /** Extra globs that may always change (tests, lockfiles...). */
  alwaysAllowed: z.array(z.string()).default([]),
  maxFilesChanged: z.number().int().min(1).optional(),
});

export const JsonAssertionSchema = z.object({
  /** Dotted path, optional filter: `verdict`, `findings[?severity==blocker]` */
  path: z.string().min(1),
  op: z.enum(['eq', 'neq', 'in', 'exists', 'count_eq', 'count_lte', 'count_gte']),
  value: z.any().optional(),
  message: z.string().min(1),
});
export type JsonAssertion = z.infer<typeof JsonAssertionSchema>;

export const JsonAssertGateSchema = z.object({
  ...gateBase,
  type: z.literal('json_assert'),
  artifact: z.string(),
  assertions: z.array(JsonAssertionSchema).min(1),
});

export const HumanApprovalGateSchema = z.object({
  ...gateBase,
  type: z.literal('human_approval'),
  instructions: z.string().default('Review the stage output before the pipeline continues.'),
  checklist: z.array(z.string()).default([]),
});

export const GateSchema = z.discriminatedUnion('type', [
  ArtifactsGateSchema,
  CommandGateSchema,
  DiffScopeGateSchema,
  JsonAssertGateSchema,
  HumanApprovalGateSchema,
]);
export type Gate = z.infer<typeof GateSchema>;
export type CommandGate = z.infer<typeof CommandGateSchema>;
export type DiffScopeGate = z.infer<typeof DiffScopeGateSchema>;
export type JsonAssertGate = z.infer<typeof JsonAssertGateSchema>;
export type HumanApprovalGate = z.infer<typeof HumanApprovalGateSchema>;

/* -------------------------------------------------------------------------- */
/*  Skills, operations, pipelines                                             */
/* -------------------------------------------------------------------------- */

export const SkillSchema = z.object({
  slug,
  name: z.string().min(1),
  /** One sentence: when the agent should apply this skill. */
  description: z.string().min(1),
  /** The skill body (markdown). Written as rules, not suggestions. */
  instructions: z.string().min(1),
  tags: z.array(z.string()).default([]),
  builtIn: z.boolean().default(false),
});
export type Skill = z.infer<typeof SkillSchema>;

export const PostActionsSchema = z.object({
  /** Commit the stage's changes to the run branch (harness-owned commit). */
  commit: z.boolean().default(true),
  /** Push the run branch after this stage's human approval. */
  push: z.boolean().default(false),
  /** Open a GitHub pull request after this stage's human approval. */
  openPullRequest: z.boolean().default(false),
});

export const OperationSchema = z.object({
  key: slug,
  name: z.string().min(1),
  description: z.string().default(''),
  /** Strict operating instructions for this operation (markdown). */
  instructions: z.string().min(1),
  skills: z.array(slug).default([]),
  provider: z.string().default('anthropic'),
  model: z.string().default('claude-opus-5-5'),
  effort: EffortSchema.default('high'),
  policy: PolicySchema,
  /**
   * Artifacts from earlier stages injected as binding inputs.
   * A missing required input blocks the stage before the agent starts.
   */
  inputs: z
    .array(z.object({ artifact: z.string(), required: z.boolean().default(true) }))
    .default([]),
  artifacts: z.array(ArtifactContractSchema).default([]),
  gates: z.array(GateSchema).default([]),
  maxAttempts: z.number().int().min(1).max(10).default(3),
  /** Operation key of an earlier stage that `rewind` gates send work back to. */
  rewindTo: z.string().optional(),
  maxRewinds: z.number().int().min(0).max(5).default(2),
  postActions: PostActionsSchema.default({ commit: true, push: false, openPullRequest: false }),
  builtIn: z.boolean().default(false),
});
export type Operation = z.infer<typeof OperationSchema>;

export const StageOverridesSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  effort: EffortSchema.optional(),
  /** Appended to the operation instructions for this pipeline only. */
  extraInstructions: z.string().optional(),
});

export const PipelineStageSchema = z.object({
  operationKey: slug,
  overrides: StageOverridesSchema.default({}),
});
export type PipelineStage = z.infer<typeof PipelineStageSchema>;

export const PipelineSchema = z.object({
  key: slug,
  name: z.string().min(1),
  description: z.string().default(''),
  /** Project constitution: global, non-negotiable rules injected into every stage. */
  constitution: z.string().default(''),
  globalPolicy: GlobalPolicySchema.default({ forbiddenPaths: [], commandDenylist: [] }),
  stages: z.array(PipelineStageSchema).min(1),
  /** Hard ceiling for one run across all stages. */
  maxRunCostUsd: z.number().min(0.01).default(25),
  /** Capture artifacts marked `captureToKnowledge` when a run completes. */
  captureKnowledge: z.boolean().default(true),
  builtIn: z.boolean().default(false),
});
export type Pipeline = z.infer<typeof PipelineSchema>;

/* -------------------------------------------------------------------------- */
/*  Repos, knowledge, schedules, settings                                     */
/* -------------------------------------------------------------------------- */

export const RepoSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().default(''),
    source: z.enum(['local', 'git']),
    /** Absolute path to an existing git working copy (source = local). */
    localPath: z.string().optional(),
    /** HTTPS clone URL (source = git). */
    gitUrl: z.string().optional(),
    /** Name of the environment variable holding a token for private repos / PRs. Never the token itself. */
    authTokenEnv: z.string().optional(),
    defaultBranch: z.string().min(1).default('main'),
    /** Named shell commands used by command gates: test, lint, typecheck, build... */
    checks: z.record(z.string(), z.string()).default({}),
  })
  .refine((r) => (r.source === 'local' ? !!r.localPath : !!r.gitUrl), {
    message: 'local repos need localPath; git repos need gitUrl',
  });
export type RepoInput = z.infer<typeof RepoSchema>;

export const KNOWLEDGE_TYPES = [
  'architecture',
  'decision',
  'convention',
  'glossary',
  'incident',
  'spec',
  'note',
] as const;

export const KnowledgeEntrySchema = z.object({
  /** null = global (applies to every repo). */
  repoId: z.string().nullable().default(null),
  type: z.enum(KNOWLEDGE_TYPES),
  title: z.string().min(1),
  content: z.string().min(1),
  tags: z.array(z.string()).default([]),
  /** Pinned entries are always injected; others are retrieved by relevance. */
  pinned: z.boolean().default(false),
  source: z.enum(['manual', 'run']).default('manual'),
  runId: z.string().optional(),
});
export type KnowledgeEntryInput = z.infer<typeof KnowledgeEntrySchema>;

export const ScheduleSchema = z.object({
  name: z.string().min(1),
  repoId: z.string().min(1),
  pipelineId: z.string().min(1),
  task: z.string().min(1),
  /** 5-field cron, server local time. */
  cron: z.string().min(1),
  enabled: z.boolean().default(true),
});
export type ScheduleInput = z.infer<typeof ScheduleSchema>;

export const ModelInfoSchema = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
  label: z.string().min(1),
  inputPerMTok: z.number().min(0),
  outputPerMTok: z.number().min(0),
  cacheReadPerMTok: z.number().min(0).default(0),
  cacheWritePerMTok: z.number().min(0).default(0),
  /** Client-side pacing: requests per minute (free tiers are often 5-15). Empty = no pacing. */
  rpmLimit: z.number().int().min(1).optional(),
  /** Client-side pacing: tokens per minute, input + output. Empty = no pacing. */
  tpmLimit: z.number().int().min(1).optional(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

export const SettingsSchema = z.object({
  /** Runs refuse to start once this month's spend reaches the budget. */
  monthlyBudgetUsd: z.number().min(0).default(200),
  /** "Run tonight" start time, HH:MM in server local time. */
  nightlyStartTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .default('22:00'),
  maxConcurrentRuns: z.number().int().min(1).max(8).default(1),
  models: z.array(ModelInfoSchema).default([]),
});
export type Settings = z.infer<typeof SettingsSchema>;

/* -------------------------------------------------------------------------- */
/*  Runs (server-managed)                                                     */
/* -------------------------------------------------------------------------- */

export const RUN_STATUSES = [
  'queued',
  'running',
  'awaiting_approval',
  'blocked',
  'completed',
  'cancelled',
  'error',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const STAGE_STATUSES = [
  'pending',
  'running',
  'gating',
  'awaiting_approval',
  'passed',
  'failed',
  'blocked',
  'skipped',
] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface GateResult {
  gateId: string;
  name: string;
  type: GateType | 'policy' | 'budget';
  passed: boolean;
  message: string;
  output?: string;
  attempt: number;
  at: string;
}

export interface StageArtifact {
  id: string;
  path: string;
  format: 'markdown' | 'json';
  content: string;
  valid: boolean;
  errors: string[];
}

export interface PolicyViolation {
  rule: string;
  detail: string;
  tool?: string;
  input?: string;
  at: string;
}

export interface RunStage {
  operationKey: string;
  name: string;
  status: StageStatus;
  attempts: number;
  rewinds: number;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  usage: Usage;
  gateResults: GateResult[];
  artifacts: StageArtifact[];
  /** Feedback queued for the next attempt (human rejection, rewind, retry). */
  feedback?: string;
  approval?: { decision: 'approved' | 'rejected'; notes: string; at: string };
  violation?: PolicyViolation;
  error?: string;
  /** Effective operation config frozen at run creation (overrides applied). */
  snapshot: Operation;
  /** Skill documents frozen at run creation. */
  skills: Pick<Skill, 'slug' | 'name' | 'description' | 'instructions'>[];
}

export interface RunPipelineSnapshot {
  pipelineId: string;
  key: string;
  name: string;
  constitution: string;
  globalPolicy: GlobalPolicy;
  maxRunCostUsd: number;
  captureKnowledge: boolean;
}

export interface Run {
  _id: string;
  title: string;
  task: string;
  repoId: string;
  repoName: string;
  pipeline: RunPipelineSnapshot;
  status: RunStatus;
  statusMessage?: string;
  currentStage: number;
  stages: RunStage[];
  branch?: string;
  baseBranch?: string;
  baseCommit?: string;
  worktreePath?: string;
  pullRequestUrl?: string;
  scheduledFor?: string;
  scheduleId?: string;
  usage: Usage;
  /** Binding decisions recorded by the human at approval gates. */
  humanNotes: { stageKey: string; notes: string; at: string }[];
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type RunEventKind =
  | 'system'
  | 'stage'
  | 'agent_text'
  | 'tool_call'
  | 'tool_result'
  | 'gate'
  | 'violation'
  | 'usage'
  | 'approval';

export interface RunEvent {
  _id?: string;
  runId: string;
  stageIndex: number | null;
  kind: RunEventKind;
  level: 'info' | 'warn' | 'error';
  message: string;
  data?: unknown;
  ts: string;
}

export const CreateRunSchema = z.object({
  repoId: z.string().min(1),
  pipelineId: z.string().min(1),
  title: z.string().max(140).optional(),
  task: z.string().min(10, 'Describe the task in at least 10 characters'),
  when: z.enum(['now', 'tonight', 'at']).default('now'),
  scheduledFor: z.string().datetime().optional(),
});
export type CreateRunInput = z.infer<typeof CreateRunSchema>;

export const ApproveSchema = z.object({
  notes: z.string().default(''),
  resume: z.enum(['now', 'tonight']).default('now'),
});
export const FeedbackSchema = z.object({ feedback: z.string().min(1, 'Feedback is required') });
export const RewindSchema = z.object({
  stageIndex: z.number().int().min(0),
  feedback: z.string().min(1, 'Feedback is required'),
});

/** Common shape for documents returned by the API. */
export type WithMeta<T> = T & { _id: string; createdAt: string; updatedAt: string };

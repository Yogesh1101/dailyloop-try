import type { ModelInfo, ToolName } from './schemas';

/** Paths no agent may read or write, in any stage. Added to every pipeline by default. */
export const DEFAULT_FORBIDDEN_PATHS = [
  '.git/**',
  '**/.env',
  '**/.env.!(example|sample|template)',
  '**/*.pem',
  '**/*.key',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/.ssh/**',
  '**/.npmrc',
  '**/.pypirc',
  '**/secrets/**',
];

/**
 * Commands no agent may run. The harness owns git history, pushes and publishing;
 * agents never do. Regexes, case-insensitive.
 */
export const DEFAULT_COMMAND_DENYLIST = [
  '\\bsudo\\b',
  '\\bgit\\s+(push|commit|reset|rebase|checkout|switch|merge|cherry-pick|revert|tag|remote|config|clean|stash|worktree|filter-branch|update-ref)\\b',
  '\\bgit\\s+branch\\s+-[dDmM]',
  '\\b(npm|pnpm|yarn|bun)\\s+publish\\b',
  '\\b(curl|wget|nc|ncat|netcat|telnet|ssh|scp|sftp|rsync|ftp)\\b',
  '\\brm\\s+-[a-zA-Z]*[rR][a-zA-Z]*\\s+(/|~|\\$HOME)(\\s|$|/\\s|/$)',
  '\\b(mkfs|fdisk|shutdown|reboot|halt|poweroff)\\b',
  '\\bdd\\s+if=',
  ':\\(\\)\\s*\\{',
  '\\bchmod\\s+(-R\\s+)?777\\b',
  '(^|[;&|(]\\s*)(printenv|env)\\s*($|[|;&)])',
  '\\bdocker\\s+(push|login)\\b',
];

export const READ_TOOLS: ToolName[] = ['read_file', 'list_dir', 'search', 'finish'];
export const WRITE_TOOLS: ToolName[] = [...READ_TOOLS, 'write_file', 'edit_file'];
export const ALL_TOOLS: ToolName[] = [...WRITE_TOOLS, 'run_command'];

/** Placeholder expanded to the run's artifact folder inside the worktree. */
export const ARTIFACTS_DIR_TOKEN = '{{artifactsDir}}';

/**
 * Seed model catalog (USD per million tokens). Editable in Settings.
 * Anthropic prices are first-party API list prices. OpenAI entries are examples:
 * verify current pricing before relying on cost gates for them.
 */
export const DEFAULT_MODELS: ModelInfo[] = [
  {
    provider: 'anthropic',
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    inputPerMTok: 4,
    outputPerMTok: 20,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 5,
  },
  {
    provider: 'anthropic',
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 2.5,
  },
  {
    provider: 'anthropic',
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
  },
  {
    provider: 'anthropic',
    id: 'claude-fable-5-1',
    label: 'Claude Fable 5.1',
    inputPerMTok: 10,
    outputPerMTok: 50,
    cacheReadPerMTok: 0.25,
    cacheWritePerMTok: 12.5,
  },
  {
    provider: 'openai',
    id: 'gpt-4.1',
    label: 'GPT-4.1 (verify pricing)',
    inputPerMTok: 2,
    outputPerMTok: 8,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 0,
  },
  {
    provider: 'openai',
    id: 'gpt-4.1-mini',
    label: 'GPT-4.1 mini (verify pricing)',
    inputPerMTok: 0.4,
    outputPerMTok: 1.6,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 0,
  },
  {
    provider: 'mock',
    id: 'mock-agent',
    label: 'Mock agent (offline demo, no API key)',
    inputPerMTok: 0,
    outputPerMTok: 0,
    cacheReadPerMTok: 0,
    cacheWritePerMTok: 0,
  },
];

export const emptyUsage = () => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
});

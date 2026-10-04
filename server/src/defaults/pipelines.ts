import type { z } from 'zod';
import { DEFAULT_COMMAND_DENYLIST, DEFAULT_FORBIDDEN_PATHS, type PipelineSchema } from '@harness/shared';

type PipelineInput = z.input<typeof PipelineSchema>;

export const DEFAULT_CONSTITUTION = `1. The approved specification is the source of truth. Code that is not traceable to an acceptance criterion does not ship.
2. Every change is small, reviewable, and proven by tests that were observed passing.
3. Security and data protection are never traded for speed.
4. When information is missing, stop and surface the question in your artifact. Never guess.
5. Follow the repository's existing conventions. Consistency beats novelty.
6. Agents never touch version control, secrets, or production systems. The harness and humans do.`;

const globalPolicy = { forbiddenPaths: DEFAULT_FORBIDDEN_PATHS, commandDenylist: DEFAULT_COMMAND_DENYLIST };

export const DEFAULT_PIPELINES: PipelineInput[] = [
  {
    key: 'standard-delivery',
    name: 'Standard Delivery (strict)',
    description:
      'Full lifecycle: brainstorm → spec → plan → implement → test → review → release. Human gates on direction, spec, plan and release; automated gates everywhere; review blockers rewind to implementation.',
    constitution: DEFAULT_CONSTITUTION,
    globalPolicy,
    stages: ['brainstorm', 'spec', 'plan', 'implement', 'test', 'review', 'release'].map((operationKey) => ({ operationKey })),
    maxRunCostUsd: 40,
    captureKnowledge: true,
    builtIn: true,
  },
  {
    key: 'discovery',
    name: 'Discovery (daytime refinement)',
    description: 'Brainstorm → spec. Use during the day to agree on what to build before committing agent time to implementation.',
    constitution: DEFAULT_CONSTITUTION,
    globalPolicy,
    stages: [{ operationKey: 'brainstorm' }, { operationKey: 'spec' }],
    maxRunCostUsd: 10,
    captureKnowledge: true,
    builtIn: true,
  },
  {
    key: 'quick-fix',
    name: 'Quick Fix',
    description: 'Plan → implement → test → review → release for small, well-understood changes. The plan defines its own acceptance criteria.',
    constitution: DEFAULT_CONSTITUTION,
    globalPolicy,
    stages: ['plan', 'implement', 'test', 'review', 'release'].map((operationKey) => ({ operationKey })),
    maxRunCostUsd: 20,
    captureKnowledge: false,
    builtIn: true,
  },
];

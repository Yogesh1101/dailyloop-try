import type { z } from 'zod';
import { ALL_TOOLS, READ_TOOLS, type OperationSchema } from '@harness/shared';

type OperationInput = z.input<typeof OperationSchema>;

const ARTIFACTS_ONLY = ['{{artifactsDir}}/**'];
const AUTHOR_TOOLS = [...READ_TOOLS, 'write_file', 'edit_file'] as const;
const TEST_GLOBS = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/test/**',
  '**/tests/**',
  '**/__tests__/**',
  '**/testdata/**',
  '**/fixtures/**',
  '**/__snapshots__/**',
];
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'poetry.lock', 'Cargo.lock', 'go.sum'];
/** Read-only commands a reviewer may run. */
const REVIEW_COMMANDS = [
  '^git\\s+(diff|log|show|status|blame)\\b',
  '^(npm|pnpm|yarn|bun)\\s+(test|run\\s+(test|lint|typecheck|build|check)[\\w:-]*)\\b',
  '^npx\\s+(tsc|eslint|vitest|jest|prettier\\s+--check)\\b',
  '^(pytest|go\\s+test|go\\s+vet|cargo\\s+(test|check|clippy)|mvn\\s+test|gradle\\s+test|make\\s+(test|lint|check))\\b',
];

export const DEFAULT_OPERATIONS: OperationInput[] = [
  {
    key: 'brainstorm',
    name: 'Brainstorm',
    description: 'Understand the task and the codebase, compare genuinely different options, recommend one, and surface every open question.',
    builtIn: true,
    effort: 'high',
    skills: ['codebase-discovery', 'brainstorm'],
    instructions: `**Goal:** understand the task and the codebase well enough to recommend a direction. You produce a decision document. You do not write code or a specification.

You MUST:
1. Apply codebase discovery before proposing anything.
2. Write \`brainstorm.md\` with every required section filled with concrete, sourced content.
3. Put every question whose answer would change the design in "Open Questions" (Q1..Qn). The human answers them at the approval gate and the answers become binding.

You MUST NOT:
- modify any file other than your artifact;
- silently choose between options with different trade-offs — surface them;
- write implementation code.`,
    policy: { allowedTools: [...READ_TOOLS, 'write_file'], writablePaths: ARTIFACTS_ONLY, maxTurns: 30, maxCostUsd: 3, timeoutMinutes: 20 },
    inputs: [],
    artifacts: [
      {
        id: 'brainstorm',
        path: 'brainstorm.md',
        format: 'markdown',
        description: 'Decision document: problem, findings, options, recommendation, risks, open questions.',
        requiredHeadings: ['Problem Understanding', 'Assumptions', 'Codebase Findings', 'Options', 'Recommendation', 'Risks', 'Open Questions'],
        minChars: 1200,
      },
    ],
    gates: [
      { id: 'contracts', name: 'Artifact contracts', type: 'artifacts', onFail: 'retry' },
      {
        id: 'approve-direction',
        name: 'Approve direction',
        type: 'human_approval',
        instructions: 'Check the recommendation and answer every open question in your approval notes; your notes become binding decisions for the spec.',
        checklist: ['The problem is understood correctly', 'Options are genuinely different', 'The recommendation is acceptable', 'Every open question is answered in the notes'],
      },
    ],
    maxAttempts: 3,
    postActions: { commit: true },
  },
  {
    key: 'spec',
    name: 'Specification',
    description: 'Write a precise, testable specification with numbered requirements and Given/When/Then acceptance criteria.',
    builtIn: true,
    effort: 'high',
    skills: ['codebase-discovery', 'spec-writing'],
    instructions: `**Goal:** a specification precise enough that two independent teams would build the same thing, and every requirement is provable by a test.

You MUST:
1. Start from the approved brainstorm recommendation (if present) and apply every human decision verbatim.
2. Number requirements (REQ-n) and acceptance criteria (AC-n); every REQ is covered by at least one AC; every AC is Given/When/Then.
3. State non-goals and non-functional requirements explicitly.

You MUST NOT:
- modify any file other than your artifact;
- introduce scope that neither the task nor the human decisions ask for;
- leave a requirement untestable.`,
    policy: { allowedTools: [...READ_TOOLS, 'write_file'], writablePaths: ARTIFACTS_ONLY, maxTurns: 30, maxCostUsd: 3, timeoutMinutes: 20 },
    inputs: [{ artifact: 'brainstorm', required: false }],
    artifacts: [
      {
        id: 'spec',
        path: 'spec.md',
        format: 'markdown',
        description: 'The specification. Source of truth for every later stage.',
        requiredHeadings: ['Summary', 'Goals', 'Non-Goals', 'Requirements', 'Acceptance Criteria', 'Non-Functional Requirements', 'Open Questions'],
        requiredPatterns: [
          { pattern: '\\bREQ-\\d+\\b', description: 'numbered requirements (REQ-1, REQ-2, ...)' },
          { pattern: '\\bAC-\\d+\\b', description: 'numbered acceptance criteria (AC-1, AC-2, ...)' },
          { pattern: 'Given[\\s\\S]+?When[\\s\\S]+?Then', description: 'acceptance criteria in Given / When / Then form' },
          { pattern: '\\b(MUST|MUST NOT|SHOULD)\\b', description: 'RFC 2119 keywords (MUST, MUST NOT, SHOULD)' },
        ],
        minChars: 1500,
        captureToKnowledge: true,
      },
    ],
    gates: [
      { id: 'contracts', name: 'Artifact contracts', type: 'artifacts', onFail: 'retry' },
      {
        id: 'approve-spec',
        name: 'Approve specification',
        type: 'human_approval',
        instructions: 'This spec becomes the source of truth. Approve only if you would accept software that does exactly this and nothing else.',
        checklist: ['Every requirement is testable', 'Acceptance criteria cover every requirement', 'Non-goals are correct', 'No open question blocks implementation'],
      },
    ],
    maxAttempts: 3,
    postActions: { commit: true },
  },
  {
    key: 'plan',
    name: 'Plan',
    description: 'Break the spec into small ordered tasks with the exact list of files each may touch.',
    builtIn: true,
    effort: 'high',
    skills: ['codebase-discovery', 'task-planning'],
    instructions: `**Goal:** an implementation plan whose file list is complete and minimal, because it becomes a hard gate: the implementation may change only the files listed in \`plan.json\`.

You MUST:
1. Cover every acceptance criterion with at least one task, and show the AC → task coverage table.
2. List exact repository-relative paths in each task's \`files\` (verify existing files exist; mark new ones).
3. Keep \`plan.md\` and \`plan.json\` consistent: same tasks, same ids, same files.

You MUST NOT:
- modify any file other than your artifacts;
- write production code;
- pad the file list "just in case" — every file needs a reason.`,
    policy: { allowedTools: [...READ_TOOLS, 'write_file'], writablePaths: ARTIFACTS_ONLY, maxTurns: 35, maxCostUsd: 3, timeoutMinutes: 25 },
    inputs: [
      { artifact: 'spec', required: false },
      { artifact: 'brainstorm', required: false },
    ],
    artifacts: [
      {
        id: 'plan',
        path: 'plan.md',
        format: 'markdown',
        description: 'Human-readable plan.',
        requiredHeadings: ['Approach', 'Tasks', 'Acceptance Criteria Coverage', 'Test Strategy', 'Risks and Rollback'],
        requiredPatterns: [
          { pattern: '\\bT\\d+\\b', description: 'numbered tasks (T1, T2, ...)' },
          { pattern: '\\bAC-\\d+\\b', description: 'references to acceptance criteria (AC-n)' },
        ],
        minChars: 800,
        captureToKnowledge: true,
      },
      {
        id: 'plan_json',
        path: 'plan.json',
        format: 'json',
        description: 'Machine-readable plan. `tasks[].files` is the diff-scope boundary for implementation.',
        jsonSchema: {
          type: 'object',
          required: ['tasks'],
          additionalProperties: true,
          properties: {
            tasks: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                required: ['id', 'title', 'files', 'acceptanceCriteria', 'tests'],
                properties: {
                  id: { type: 'string', pattern: '^T\\d+$' },
                  title: { type: 'string', minLength: 3 },
                  files: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
                  acceptanceCriteria: { type: 'array', items: { type: 'string', pattern: '^AC-\\d+$' } },
                  tests: { type: 'array', items: { type: 'string' } },
                  dependsOn: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    ],
    gates: [
      { id: 'contracts', name: 'Artifact contracts', type: 'artifacts', onFail: 'retry' },
      {
        id: 'approve-plan',
        name: 'Approve plan',
        type: 'human_approval',
        instructions: 'The file list in plan.json is the hard boundary for implementation: anything not listed will be rejected. Approve with "Continue tonight" to run implementation overnight.',
        checklist: ['Every acceptance criterion is covered', 'The file list is complete and minimal', 'Tasks are small and ordered', 'Risks and rollback are credible'],
      },
    ],
    maxAttempts: 3,
    postActions: { commit: true },
  },
  {
    key: 'implement',
    name: 'Implement',
    description: 'Write the code for the approved plan, inside the plan’s file boundary, with tests passing.',
    builtIn: true,
    effort: 'xhigh',
    skills: ['codebase-discovery', 'scope-discipline', 'test-driven-development', 'verification-before-completion'],
    instructions: `**Goal:** implement every task in the approved plan, in order, so that every acceptance criterion is met and the build and tests are green.

You MUST:
1. Work task by task (T1, T2, ...). Read before you edit. Run the relevant tests after each task.
2. Change only files listed in \`plan.json\` (plus lockfiles when the plan adds a dependency). The diff-scope gate rejects anything else.
3. Write tests for each acceptance criterion as you go.
4. Record in \`implementation.md\`: what changed per task, the status of each AC, verification evidence (commands + key output lines), and any deviation you did NOT make but believe is needed.

You MUST NOT:
- touch files outside the plan, even to fix unrelated problems you notice (record them instead);
- weaken, skip or delete tests;
- commit, push or change branches (the harness owns git).`,
    policy: {
      allowedTools: ALL_TOOLS,
      writablePaths: ['**'],
      maxTurns: 90,
      maxCostUsd: 12,
      timeoutMinutes: 75,
      commandTimeoutSeconds: 600,
    },
    inputs: [
      { artifact: 'plan_json', required: true },
      { artifact: 'plan', required: false },
      { artifact: 'spec', required: false },
    ],
    artifacts: [
      {
        id: 'implementation',
        path: 'implementation.md',
        format: 'markdown',
        description: 'Implementation report with evidence.',
        requiredHeadings: ['Summary of Changes', 'Files Changed', 'Acceptance Criteria Status', 'Verification Evidence', 'Deviations from Plan'],
        requiredPatterns: [{ pattern: '\\bAC-\\d+\\b', description: 'the status of each acceptance criterion (AC-n)' }],
        minChars: 600,
      },
    ],
    gates: [
      { id: 'contracts', name: 'Artifact contracts', type: 'artifacts', onFail: 'retry' },
      { id: 'scope', name: 'Plan scope', type: 'diff_scope', planArtifact: 'plan_json', filesPath: 'tasks[].files', alwaysAllowed: LOCKFILES, onFail: 'retry' },
      { id: 'typecheck', name: 'Typecheck', type: 'command', check: 'typecheck', required: false, onFail: 'retry' },
      { id: 'lint', name: 'Lint', type: 'command', check: 'lint', required: false, onFail: 'retry' },
      { id: 'build', name: 'Build', type: 'command', check: 'build', required: false, onFail: 'retry', timeoutSeconds: 1200 },
      { id: 'tests', name: 'Tests', type: 'command', check: 'test', required: true, onFail: 'retry', timeoutSeconds: 1800 },
    ],
    maxAttempts: 4,
    postActions: { commit: true },
  },
  {
    key: 'test',
    name: 'Test',
    description: 'Strengthen the test suite until every acceptance criterion is proven, then run the full suite.',
    builtIn: true,
    effort: 'high',
    skills: ['test-driven-development', 'verification-before-completion'],
    instructions: `**Goal:** independent verification. Every acceptance criterion must be proven by at least one test that you observed passing.

You MUST:
1. Build a coverage matrix: each AC-n → the test(s) proving it (file and test name).
2. Add missing tests (failure paths and edge cases included). You may only write test files.
3. Run the full test suite and record the exact command and summary output.

You MUST NOT:
- modify production code — if a test exposes a bug, record it under "Gaps" as a blocker for review;
- weaken, skip or delete existing tests.`,
    policy: {
      allowedTools: ALL_TOOLS,
      writablePaths: TEST_GLOBS,
      maxTurns: 60,
      maxCostUsd: 6,
      timeoutMinutes: 45,
      commandTimeoutSeconds: 900,
    },
    inputs: [
      { artifact: 'spec', required: false },
      { artifact: 'plan_json', required: false },
      { artifact: 'implementation', required: false },
    ],
    artifacts: [
      {
        id: 'test_report',
        path: 'test-report.md',
        format: 'markdown',
        description: 'Coverage matrix and observed test results.',
        requiredHeadings: ['Coverage Matrix', 'Tests Added', 'Test Results', 'Gaps'],
        requiredPatterns: [{ pattern: '\\bAC-\\d+\\b', description: 'every acceptance criterion in the coverage matrix (AC-n)' }],
        minChars: 400,
      },
    ],
    gates: [
      { id: 'contracts', name: 'Artifact contracts', type: 'artifacts', onFail: 'retry' },
      { id: 'tests', name: 'Full test suite', type: 'command', check: 'test', required: true, onFail: 'retry', timeoutSeconds: 1800 },
    ],
    maxAttempts: 3,
    postActions: { commit: true },
  },
  {
    key: 'review',
    name: 'Review',
    description: 'Adversarial review of the whole change against spec, plan and security. Blockers send the work back to implementation.',
    builtIn: true,
    effort: 'high',
    skills: ['code-review', 'security-review'],
    instructions: `**Goal:** decide whether this change is safe to ship. You are the last line of defence before the human release gate.

You MUST:
1. Review the complete diff against the base commit and every changed file in full.
2. Verify each acceptance criterion against the code and the tests; mark each verified / not verified with evidence.
3. Write findings to both \`review.md\` (readable) and \`review.json\` (machine-readable). They must agree.
4. Set verdict "request_changes" if there is any blocker or major finding; otherwise "approve".

You MUST NOT:
- modify code or tests;
- approve a change with an unverified acceptance criterion.

If the verdict is "request_changes", the harness sends your findings back to the Implement stage automatically.`,
    policy: {
      allowedTools: [...READ_TOOLS, 'write_file', 'run_command'],
      writablePaths: ARTIFACTS_ONLY,
      commandAllowlist: REVIEW_COMMANDS,
      maxTurns: 45,
      maxCostUsd: 5,
      timeoutMinutes: 30,
    },
    inputs: [
      { artifact: 'spec', required: false },
      { artifact: 'plan_json', required: false },
      { artifact: 'implementation', required: false },
      { artifact: 'test_report', required: false },
    ],
    artifacts: [
      {
        id: 'review',
        path: 'review.md',
        format: 'markdown',
        description: 'Readable review.',
        requiredHeadings: ['Scope Reviewed', 'Acceptance Criteria Verification', 'Findings', 'Security', 'Verdict'],
        minChars: 500,
        rejectPlaceholders: false,
      },
      {
        id: 'review_json',
        path: 'review.json',
        format: 'json',
        description: 'Machine-readable verdict and findings.',
        jsonSchema: {
          type: 'object',
          required: ['verdict', 'summary', 'findings'],
          properties: {
            verdict: { enum: ['approve', 'request_changes'] },
            summary: { type: 'string', minLength: 10 },
            findings: {
              type: 'array',
              items: {
                type: 'object',
                required: ['severity', 'file', 'title', 'detail', 'fix'],
                properties: {
                  severity: { enum: ['blocker', 'major', 'minor', 'nit'] },
                  file: { type: 'string' },
                  line: { type: 'integer' },
                  title: { type: 'string' },
                  detail: { type: 'string' },
                  fix: { type: 'string' },
                },
              },
            },
          },
        },
      },
    ],
    gates: [
      { id: 'contracts', name: 'Artifact contracts', type: 'artifacts', onFail: 'retry' },
      {
        id: 'verdict',
        name: 'Review verdict',
        type: 'json_assert',
        artifact: 'review_json',
        onFail: 'rewind',
        assertions: [
          { path: 'findings[?severity==blocker]', op: 'count_eq', value: 0, message: 'There must be no blocker findings' },
          { path: 'findings[?severity==major]', op: 'count_eq', value: 0, message: 'There must be no major findings' },
          { path: 'verdict', op: 'eq', value: 'approve', message: 'The reviewer verdict must be "approve"' },
        ],
      },
    ],
    maxAttempts: 2,
    rewindTo: 'implement',
    maxRewinds: 2,
    postActions: { commit: true },
  },
  {
    key: 'release',
    name: 'Release',
    description: 'Prepare the changelog and pull request. Final human gate; approval can push and open a PR.',
    builtIn: true,
    effort: 'medium',
    skills: ['release-notes'],
    instructions: `**Goal:** package the approved change for humans: a precise PR title and description, a changelog entry, and the evidence trail.

You MUST:
1. Write \`release.md\` with every required section. Copy testing evidence from earlier artifacts; do not invent any.
2. Add an entry to \`CHANGELOG.md\` (create it if missing) under an "Unreleased" heading.

You MUST NOT:
- modify any file other than your artifact and CHANGELOG.md;
- claim testing or review results that earlier artifacts do not show.`,
    policy: { allowedTools: AUTHOR_TOOLS as unknown as OperationInput['policy']['allowedTools'], writablePaths: [...ARTIFACTS_ONLY, 'CHANGELOG.md'], maxTurns: 20, maxCostUsd: 2, timeoutMinutes: 15 },
    inputs: [
      { artifact: 'review_json', required: true },
      { artifact: 'spec', required: false },
      { artifact: 'implementation', required: false },
      { artifact: 'test_report', required: false },
      { artifact: 'review', required: false },
    ],
    artifacts: [
      {
        id: 'release',
        path: 'release.md',
        format: 'markdown',
        description: 'PR title, PR description, changelog entry, evidence and rollback.',
        requiredHeadings: ['PR Title', 'PR Description', 'Changelog', 'Testing Evidence', 'Risks and Rollback'],
        requiredPatterns: [
          {
            pattern: '^#+\\s*PR Title\\s*\\n+\\s*(feat|fix|docs|refactor|perf|test|chore|build|ci)(\\([\\w./-]+\\))?!?: .{1,72}$',
            description: 'a Conventional Commits PR title on the line after "PR Title"',
          },
        ],
        minChars: 400,
      },
    ],
    gates: [
      { id: 'contracts', name: 'Artifact contracts', type: 'artifacts', onFail: 'retry' },
      {
        id: 'approve-release',
        name: 'Approve release',
        type: 'human_approval',
        instructions: 'Final gate. Review the full diff and the evidence trail. Approving runs the post-actions (push / pull request) if they are enabled for this operation.',
        checklist: ['The diff matches the approved spec and plan', 'Testing evidence is real', 'The PR description is accurate', 'Rollback is possible'],
      },
    ],
    maxAttempts: 3,
    postActions: { commit: true, push: false, openPullRequest: false },
  },
];

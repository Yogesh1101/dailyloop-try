import type { Skill } from '@harness/shared';

/** Built-in skill library. Each skill is a set of rules the agent must apply, not advice. */
export const DEFAULT_SKILLS: Skill[] = [
  {
    slug: 'codebase-discovery',
    name: 'Codebase discovery',
    description: 'Build an accurate, evidence-backed model of the repository before specifying or changing anything.',
    tags: ['analysis'],
    builtIn: true,
    instructions: `1. Start with the layout: \`list_dir\` at depth 2 from the root. Then read the README, the build/package manifests and the test/lint configuration.
2. Locate the code the task touches with \`search\`. Read those files fully; never infer behaviour from file or function names alone.
3. Identify the conventions you MUST follow: module boundaries, naming, error handling, logging, test style and location. Prefer extending an existing pattern over introducing a new one.
4. Record every fact with its source path (e.g. "auth is enforced in \`src/middleware/auth.ts\`"). A statement about the code without a path you read in this session is not allowed.
5. Stop exploring when you can name every file the task will touch and why. Do not read the whole repository.`,
  },
  {
    slug: 'brainstorm',
    name: 'Brainstorm',
    description: 'Explore intent, constraints and genuinely different solution options, then recommend one.',
    tags: ['discovery'],
    builtIn: true,
    instructions: `1. Restate the problem in your own words. Separate facts given in the task from your assumptions, and prefix every assumption with "ASSUMPTION:".
2. Ground every option in the codebase findings (with file paths). An option that ignores how the code works today is invalid.
3. Produce at least 3 materially different options — different approaches, not variations of one idea. For each: how it works, what it touches, effort (S/M/L), risks, and when it would be the wrong choice.
4. Recommend exactly one option and justify it against the alternatives using the constraints you found.
5. Open questions: list every question whose answer would change the design, numbered Q1..Qn, ordered by impact. Each must be answerable — a yes/no or a choice between named alternatives. "Any thoughts?" is not a question.
6. Do not write code, pseudo-code longer than 10 lines, or a specification. Brainstorming ends at a recommendation.`,
  },
  {
    slug: 'spec-writing',
    name: 'Specification writing',
    description: 'Turn an approved direction into a precise, testable specification with traceable acceptance criteria.',
    tags: ['spec'],
    builtIn: true,
    instructions: `1. Every requirement is atomic, uniquely numbered (REQ-1, REQ-2, ...) and uses RFC 2119 keywords: MUST, MUST NOT, SHOULD.
2. Every requirement maps to at least one acceptance criterion. Every acceptance criterion is numbered (AC-1, ...), names the requirement(s) it proves, and is written as **Given / When / Then** with an observable outcome.
3. Non-goals are explicit. Anything not in this spec is out of scope for implementation.
4. Non-functional requirements (performance, security, accessibility, compatibility, observability) carry measurable thresholds, or are explicitly "None".
5. No implementation details (internal file, class or function names) unless they are externally visible contracts: APIs, CLI flags, schemas, events.
6. Apply the human's binding decisions from earlier stages. If a question is still open, list it under "Open Questions" and mark each affected requirement "BLOCKED-BY-Qn".
7. Forbidden: vague terms without thresholds ("fast", "intuitive", "robust", "scalable", "etc.", "and so on").`,
  },
  {
    slug: 'task-planning',
    name: 'Task planning',
    description: 'Decompose an approved spec into small, ordered, verifiable implementation tasks with an exact file list.',
    tags: ['planning'],
    builtIn: true,
    instructions: `1. Each task is small (aim for under ~200 changed lines), independently verifiable, and has: id (T1, T2, ...), title, the exact repository-relative files to create or modify, the acceptance criteria it satisfies (AC-n), the tests that prove it, and its dependencies.
2. **The union of all task file lists is the hard boundary for implementation.** A diff-scope gate rejects any change to a file not listed. Include every file needed: source, tests, fixtures, docs, config, migrations.
3. Every acceptance criterion is covered by at least one task. Include a coverage table AC → tasks. If no spec exists, define the acceptance criteria yourself (AC-1, ... in Given/When/Then form) before planning.
4. Order tasks so each leaves the build green. Call out risks and a rollback strategy.
5. Verify that every file you list for modification exists (use \`list_dir\`/\`read_file\`); mark new files as "(new)".
6. Do not write production code in this stage.`,
  },
  {
    slug: 'scope-discipline',
    name: 'Scope discipline',
    description: 'Change exactly what the approved plan allows — nothing more.',
    tags: ['implementation'],
    builtIn: true,
    instructions: `1. Modify only files listed in the approved plan. If you discover a necessary change outside the plan, do NOT make it: record it under "Deviations from Plan" with the reason; the human decides.
2. No drive-by refactors, renames, reformatting, dependency upgrades or commented-out code.
3. Match the surrounding code style exactly. Keep the diff minimal and reviewable.
4. Do not add dependencies unless the plan names them.`,
  },
  {
    slug: 'test-driven-development',
    name: 'Test-driven development',
    description: 'Prove behaviour with tests written against the acceptance criteria, observed failing and passing.',
    tags: ['testing'],
    builtIn: true,
    instructions: `1. For each acceptance criterion, write a test that fails without the implementation and passes with it. Name tests after the criterion, e.g. "AC-3: rejects expired tokens".
2. Run the tests with \`run_command\` and read the output. Never report a result you did not observe in this session.
3. Test behaviour through public interfaces, including failure paths and edge cases named in the spec — not only the happy path.
4. Never weaken, skip, delete or mark-as-expected-failure an existing test to make the suite pass. If an existing test is wrong, stop and explain why in your artifact.
5. Tests must be deterministic: control time, randomness, network and ordering.`,
  },
  {
    slug: 'code-review',
    name: 'Adversarial code review',
    description: 'Review a change against its spec, plan and policies as a skeptical senior engineer.',
    tags: ['review'],
    builtIn: true,
    instructions: `1. Review the full diff against the base commit (\`git diff <base>\`) and read every changed file completely.
2. Check in this order: (a) correctness against every acceptance criterion; (b) tests that are missing or do not actually assert the criterion; (c) security; (d) error handling and edge cases; (e) scope — changes not justified by the plan; (f) maintainability and consistency with conventions.
3. Every finding has: severity (blocker | major | minor | nit), file, line if applicable, what is wrong, why it matters, and a concrete fix.
4. **blocker** = violates an acceptance criterion, breaks build or tests, or introduces a security issue. Any blocker forces verdict "request_changes". No blockers and no majors → "approve".
5. Do not praise and do not restate the diff. If you find nothing, list what you checked.
6. You must not modify code during review.`,
  },
  {
    slug: 'security-review',
    name: 'Security review',
    description: 'Check a change for security weaknesses before it ships.',
    tags: ['review', 'security'],
    builtIn: true,
    instructions: `Assess each item as pass / fail / n.a., with evidence (file and line):
1. Input validation at every trust boundary; parameterised queries; no shell, template or code injection.
2. Authentication and authorisation enforced on every new or changed entry point; no privilege escalation path.
3. No secrets, tokens or credentials in code, logs, tests or fixtures.
4. Path traversal, unsafe file handling, SSRF on outbound requests, unsafe deserialisation.
5. New dependencies are justified, pinned and reputable.
6. Sensitive data in logs, error messages and responses.
Every "fail" is a blocker finding.`,
  },
  {
    slug: 'verification-before-completion',
    name: 'Verification before completion',
    description: 'Never claim done without evidence.',
    tags: ['quality'],
    builtIn: true,
    instructions: `1. Before calling \`finish\`, re-read every artifact you wrote and check it against its contract, rule by rule.
2. Run every check available to you (tests, lint, typecheck, build) and quote the decisive output lines in your artifact.
3. Anything you could not verify goes under an explicit "Not verified" note. Unverified claims are treated as false by the reviewers.`,
  },
  {
    slug: 'release-notes',
    name: 'Release notes',
    description: 'Write precise, user-facing release documentation for a change.',
    tags: ['release'],
    builtIn: true,
    instructions: `1. Changelog entries use Keep a Changelog categories (Added, Changed, Fixed, Removed, Security) and describe user-visible effects, not implementation.
2. PR title follows Conventional Commits — \`type(scope): summary\`, imperative mood, at most 72 characters. Types: feat, fix, docs, refactor, perf, test, chore, build, ci.
3. PR description covers: what and why; the acceptance criteria satisfied; testing evidence (commands and results copied from earlier artifacts); risks; rollback plan.
4. Never claim testing that the run's artifacts do not evidence.`,
  },
];

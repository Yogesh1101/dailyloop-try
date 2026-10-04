# Agentic Harness

Configure, gate and run AI agents across every software-delivery operation — brainstorm, spec, plan, implement, test, review, release — with **strict instructions** and **hard gates** that agents cannot talk their way past.

Inspired by McKinsey's [*Rewiring software delivery for the agentic era*](https://www.mckinsey.com/capabilities/technology/our-insights/rewiring-software-delivery-for-the-agentic-era): humans set direction and review at defined gates; agents execute between them, around the clock; handoffs are machine-readable; a knowledge layer gives agents the project's memory.

| Article idea | In the harness |
|---|---|
| The 24-hour sprint | Approve a plan during the day with **Continue tonight**; implementation, testing and review run overnight; the release gate waits for you in the morning. Cron **schedules** for recurring work. |
| Eliminate human handoffs | Every stage hands off **artifact contracts** (markdown with required sections, JSON with a schema). The next stage receives them as binding inputs. |
| Humans only at defined review gates | **Human approval gates** with a checklist that must be ticked before Approve unlocks. Notes become binding decisions for every later stage. |
| Knowledge graphs as the memory layer | A per-repo and global **knowledge base** (decisions, conventions, glossary, incidents). Pinned entries are always injected; approved specs and plans are captured automatically. |
| Smaller teams, more leverage | One person configures the operating model once — operations, skills, pipelines, guardrails — and every run follows it exactly. |

It does both things you'd want from a harness:

- **Runs agents itself** (MERN + TypeScript, pluggable providers), enforcing every gate and guardrail on every tool call.
- **Exports the same contract to Claude Code** (`CLAUDE.md`, `AGENTS.md`, slash commands, skills, a guard hook and a gate runner) so the rules hold when you work in the terminal too.

---

## Quick start

Requirements: Node 20+, git, MongoDB (local, Docker or Atlas).

```bash
npm install
docker compose up -d          # MongoDB on 127.0.0.1:27017 (or set MONGODB_URI)
cp .env.example .env          # add ANTHROPIC_API_KEY and/or OPENAI_API_KEY (optional)

npm run dev                   # API on :4000, UI on http://127.0.0.1:5173
# or, production-style:
npm run build && npm start    # API + UI on http://127.0.0.1:4000
```

Then:

1. **Repositories → Add repository.** Point at a local git checkout, or paste a Git URL to clone. Click **Detect** to fill in checks (`test`, `lint`, `typecheck`, `build`) and save.
2. **New run.** Pick the repo and *Standard Delivery (strict)*, describe the task, start.
3. Review each **human gate** in **Approvals**: read the artifacts, the diff and the gate results, tick the checklist, approve (with binding notes), reject with feedback, or rewind to an earlier stage.

No API key yet? Duplicate a pipeline and set each stage's provider override to `mock`. The offline mock agent writes contract-valid artifacts, so you can exercise policies, gates, approvals, rewinds and budgets end to end.

---

## Concepts

### Operation — the contract for one kind of work

An operation defines everything an agent may and must do in a stage:

| Part | What it is |
|---|---|
| **Instructions** | Strict, MUST / MUST NOT rules for this operation. |
| **Skills** | Reusable rule sets (brainstorm, spec writing, TDD, adversarial review, security review…) injected verbatim. |
| **Model** | Provider, model and effort. Overridable per pipeline stage. |
| **Policy guardrails** | Allowed tools, writable paths, forbidden paths, command allow/deny lists, and turn, token, cost and time budgets. **Any violation halts the stage and blocks the run.** |
| **Inputs** | Artifacts from earlier stages, required or optional. A missing required input blocks the stage before the agent starts. |
| **Artifact contracts** | Files the agent must produce, at exact paths: required headings with non-empty sections, required regex patterns, minimum length, no placeholders, a JSON Schema. |
| **Gates** | Checks that run after the agent calls `finish` (below). |
| **Retries / rewinds** | `maxAttempts` for retry gates; `rewindTo` + `maxRewinds` to send work back to an earlier stage. |
| **Post-actions** | Commit the stage output to the run branch; after approval, push and open a GitHub PR. |

Built-ins: **Brainstorm, Specification, Plan, Implement, Test, Review, Release.** Edit them freely; **Reset** restores the default.

### Gates

Gates run in a fixed order. A human gate only opens once every automated gate passes.

1. **Artifact contracts** — every required artifact exists and satisfies its contract.
2. **JSON assertions** — e.g. in `review.json`: `findings[?severity==blocker]` count is 0 and `verdict` equals `"approve"`.
3. **Diff scope** — the only files that may differ from the base commit are those listed in the approved `plan.json` (`tasks[].files`), plus allowed globs such as lockfiles.
4. **Command checks** — repo checks (`test`, `lint`…) or literal commands must exit with the expected code. Missing required checks fail; optional ones are skipped and recorded.
5. **Human approval** — instructions plus a checklist. Approve, reject with feedback, or rewind.

Each automated gate chooses what happens on failure:

- **retry** feeds the exact failure output back to the agent, up to `maxAttempts`.
- **rewind** sends the findings back to the `rewindTo` stage. The built-in Review rewinds to Implement on blockers.
- **halt** blocks the run for a human.

Budgets (stage, run, monthly) and policy violations always halt.

### Pipeline

An ordered list of operations plus:

- a **constitution** of global rules injected into every stage;
- **global guardrails** (forbidden paths and denied commands that operations can add to but never remove);
- a **run budget**;
- knowledge capture.

Built-ins: **Standard Delivery (strict)**, **Discovery** (brainstorm → spec) and **Quick Fix** (plan → … → release).

### Run

A run freezes its pipeline, operations and skills at creation, so later edits never change in-flight work. It works on a new branch, `harness/<title>-<id>`, in an isolated **git worktree**; your checkout and current branch are never modified. Every tool call, result, gate and approval is in the audit log, streamed live. The **Prompt** tab shows exactly what the agent received.

---

## Strictness, concretely

The harness owns every tool, so enforcement is identical for every provider:

- **Paths.** Paths are resolved against the worktree. `..`, absolute paths and symlink escapes are violations. Forbidden paths (`.env`, keys, `.git/**`, `secrets/**`…) are hidden from listings and search, and reading them is a violation.
- **Writes.** Writes outside `writablePaths` are violations. `.harness/` is harness-owned: a stage may write only its own artifacts, and earlier artifacts are immutable.
- **Shell.** `run_command` checks the denylist (git state changes, network tools, publishing, sudo…), the allowlist, and literal references to forbidden files. It then **snapshots the working tree around each command**: a command that modifies a read-only file is a violation.
- **Secrets.** Commands and gates run with a scrubbed environment, so API keys and tokens are never visible to agents.
- **Budgets.** Turns, tokens, cost and time are enforced per stage; cost per run and per month.
- **Truncated output.** Responses cut off mid-tool-call are never executed. A refusal fails the stage cleanly.
- **Integrity.** Only the harness commits; agents cannot commit, push or change branches. The system prompt states the full contract — tools, paths, artifacts, gates, budgets, evidence-over-assertion, untrusted-content handling — and stays byte-stable across turns so it is prompt-cached.

---

## The 24-hour sprint

1. Daytime: run **Discovery** or the first stages of **Standard Delivery**. Answer the brainstorm's open questions in the approval notes; they become binding.
2. Approve the plan with **Continue tonight** (the time is set in Settings → *"Tonight" starts at*). The run is queued for that time.
3. Overnight: Implement → Test → Review run unattended. A blocker from Review automatically rewinds to Implement, up to `maxRewinds`. Budgets cap spend.
4. Morning: the release gate is in **Approvals**, with the diff and the full evidence trail.

**Schedules** cover recurring work with cron, e.g. weeknights `0 22 * * 1-5`.

---

## Export to Claude Code

**Export** generates, for a pipeline (and optionally a repo):

| File | Purpose |
|---|---|
| `CLAUDE.md`, `AGENTS.md` | Constitution, operation flow, hard rules and pinned knowledge. |
| `.claude/commands/harness-<op>.md` | One slash command per operation, carrying the full contract. |
| `.claude/skills/<slug>/SKILL.md` | Each skill used. |
| `.claude/settings.json` | Permission denies plus a `PreToolUse` hook. |
| `.claude/hooks/harness-guard.mjs` | Blocks forbidden paths and denied commands; blocks writes outside the active operation's scope and to other operations' artifacts; blocks agents from recording approvals. |
| `.harness/gates.mjs` | `start` refuses until earlier operations passed and were approved; `check` runs artifact, JSON-assertion, diff-scope and command gates. |
| `.harness/pipeline.json`, `.harness/policy.json` | The machine-readable contract. |

The human approves with:

```bash
node .harness/gates.mjs approve <operation> <task-slug> "notes"
```

Export-mode enforcement is best-effort compared to in-harness runs: Claude Code's shell can still write files the hook can't see. In-harness runs snapshot the working tree around every command and meter cost.

---

## Providers

| Provider | Setup |
|---|---|
| `anthropic` | `ANTHROPIC_API_KEY`. Default model `claude-opus-5-5`; adaptive thinking with per-operation effort, streaming, prompt caching, server-side refusal fallback. |
| `openai` | `OPENAI_API_KEY`; set `OPENAI_BASE_URL` for any OpenAI-compatible server (Ollama, vLLM, LM Studio, gateways). |
| `mock` | Always available, offline. |

**Add a provider:** implement `AgentProvider` (`server/src/providers/types.ts`). It needs one `complete()` call per turn that returns text, tool calls, stop reason and usage. Register it in `providers/registry.ts`. Tools, policies and gates work unchanged.

Model prices live in **Settings → Model catalog** and drive cost tracking and budget gates. Verify prices for non-Anthropic models.

---

## Architecture

```
shared/   zod schemas + types: operations, gates, policies, artifacts, runs (single source of truth)
server/   Express 5 + Mongoose 9
  engine/      policy · tools · agentLoop · prompt · gates · artifacts · runner (state machine)
               queue (worker) · actions (approve/reject/retry/rewind) · workspace (git worktrees)
  providers/   anthropic · openai · mock · registry
  export/      Claude Code generator + guard hook and gate-runner assets
  knowledge/   retrieval and capture
  scheduler/   cron (croner)
  routes/      REST + Server-Sent Events
client/   React 19 + Vite + TanStack Query
```

State lives in MongoDB: runs (with frozen snapshots), events (audit log), per-turn usage records, knowledge, schedules and settings. The runner is restart-safe: a run interrupted mid-stage is blocked for a human on boot, never silently resumed.

---

## Security model

- Single local user. The server binds to `127.0.0.1` and rejects non-loopback `Host` headers (DNS rebinding) and cross-origin browser requests. **Do not expose it to a network.**
- Credentials come from the server environment only. Repos reference a token by env-var name, and it is passed to git per invocation, never written to `.git/config`.
- Agents run real commands in a worktree of your repository with your user's permissions. The policy engine is a strong guardrail, **not an OS sandbox**. For untrusted tasks, run the harness inside a container or VM.

---

## Development

```bash
npm run typecheck                                  # shared, server, client
npm test                                           # unit tests (policy, tools, gates, agent loop, prompt, export)
E2E_MONGODB_URI=mongodb://127.0.0.1:27017 npm test # + end-to-end runs: violation halt, review rewind, rejection, budget
```

---

## Known limits (v1)

- **Knowledge retrieval is keyword-based** (title > tags > body), not embeddings or a true graph.
- **Pull requests are GitHub-only**; push works with any git remote.
- **One process.** The queue and scheduler are in-process; run one server per database.

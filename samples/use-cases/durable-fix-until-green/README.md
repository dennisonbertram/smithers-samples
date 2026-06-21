# Durable "fix until tests pass" coding agent

> An AI agent that automatically fixes a TypeScript bug by looping until all tests go green — and survives process death via durable resume.

## TL;DR

Hand it a file with a bug and a failing test suite. The AI reads the broken code, applies a fix, runs the tests, and loops — up to five times — until every test passes. If the process is killed mid-run, resume it and Smithers picks up exactly where it stopped. No work is repeated.

**Teaches:** AnthropicAgent, Loop, Sequence, Task (compute), `createSmithers` output schemas, durability / resume, `ctx.latest`
**Prerequisites:** Bun ≥ 1.3 · `ANTHROPIC_API_KEY`

## What it does

The workflow starts with a deliberately broken `src/slugify.ts` (one character bug: `+` instead of `-`). An `AnthropicAgent` (claude-haiku-4-5) reads the source and tests, applies a fix, then a compute task runs `bun test` and parses the result. A `<Loop>` repeats this pair until `testResult.passed === true` or five iterations are exhausted. Kill the process mid-run, resume with `--resume true`, and Smithers picks up from the last completed step — no steps are re-run.

## Build & run

```bash
bun install

export ANTHROPIC_API_KEY=sk-ant-...

# Confirm tests start RED (1 pass, 4 fail)
bun test src/slugify.test.ts

# Run the workflow
bunx --bun smithers-orchestrator up workflow.tsx --run-id fix-run-1

# Confirm tests are now GREEN (5 pass, 0 fail)
bun test src/slugify.test.ts

# Inspect output tables
sqlite3 smithers.db "SELECT run_id, node_id, iteration, summary FROM implement_result;"
sqlite3 smithers.db "SELECT run_id, node_id, iteration, passed, pass_count, fail_count FROM test_result;"
```

### Durability demo (optional)

Reset `src/slugify.ts` to the buggy state (change the `-` back to `+`), then:

```bash
# Start a new run detached
bunx --bun smithers-orchestrator up workflow.tsx --run-id uc1-resume-demo -d
# PID is printed — kill it mid-flight
kill -9 <PID>

# Wait ~40 s for the heartbeat to go stale, then resume
bunx --bun smithers-orchestrator up workflow.tsx --run-id uc1-resume-demo --resume true

# Verify the attempts table shows a cancelled attempt and a resumed attempt
sqlite3 smithers.db \
  "SELECT run_id, node_id, iteration, attempt, state FROM _smithers_attempts ORDER BY run_id, node_id, attempt;"
```

> **Note:** Keep `workflow.tsx` unchanged between kill and resume. Smithers hashes the workflow source; a modified file will block the resume.

## Expected output

Example output (one loop iteration, ~24 s):

```
[00:00:00] → implement (attempt 1, iteration 0)
[00:00:24] ✓ implement (attempt 1)
[00:00:24] → run-tests (attempt 1, iteration 0)
[00:00:24] ✓ run-tests (attempt 1)
[00:00:24] ✓ Run finished
{"runId":"fix-run-1","status":"finished"}
```

Key SQLite rows after the run:

```
-- implement_result
fix-run-1|implement|0|Fixed the bug in src/slugify.ts by changing the replace pattern for spaces from '+' to '-' on line 22...|["src/slugify.ts"]

-- test_result
fix-run-1|run-tests|0|1|5|0
-- columns: run_id | node_id | iteration | passed | pass_count | fail_count
```

Resume demo `_smithers_attempts`:

```
uc1-resume-demo | implement | 0 | 1 | cancelled   ← the killed attempt
uc1-resume-demo | implement | 0 | 2 | finished    ← resumed, new attempt
uc1-resume-demo | run-tests | 0 | 1 | finished
```

## How it works

`workflow.tsx` defines one top-level `<Loop id="fix-loop" until={isDone} maxIterations={5}>` containing a `<Sequence>` of two tasks:

1. **`implement` (Task + AnthropicAgent)** — haiku-4-5 with `read`, `write`, `edit`, and `bash` tools. Reads `src/slugify.ts` and `src/slugify.test.ts`, applies a fix, returns a structured `implementResult` (summary + files modified).

2. **`run-tests` (Task, compute)** — an `async () => {}` function that calls `execSync("bun test ...")`, parses the pass/fail counts from stdout, and returns a structured `testResult` (including `passed: boolean`).

The loop exit condition is evaluated at the top of each iteration via `ctx.latest(outputs.testResult, "run-tests")`. All output schemas are declared with `createSmithers(...)` and persisted to typed SQLite tables (`implement_result`, `test_result`) automatically.

## Key gotchas

1. **Use `ctx.latest`, not `ctx.outputMaybe`, for the loop exit condition.** `ctx.outputMaybe({ nodeId })` pins to iteration 0; inside a loop you need the highest-iteration result. `ctx.latest(outputs.table, nodeId)` returns it.

2. **Use `z.string()` for numeric counts, not `z.number()`.** Smithers maps `z.number()` to SQLite INTEGER, which silently truncates fractions and can cause type confusion. This sample stores `passCount` and `failCount` as strings to avoid surprises.

3. **Killed attempt → `cancelled`, not `failed`.** When the process is killed, Smithers marks the in-flight attempt as `cancelled` (heartbeat went stale). Resume creates a new attempt without consuming a retry slot — retries are for validation failures, not process death.

## What you'll learn & how to apply it

### What you'll learn

This sample teaches the **durable retry loop** pattern: wrapping an AI agent and a validation step inside a `<Loop>` so the agent keeps trying until a measurable criterion is met, with Smithers persisting every attempt to SQLite so the run can survive a crash and resume without re-doing completed work. The key primitives are `<Loop until={condition} maxIterations={n}>`, `ctx.latest(...)` for reading the current iteration's output, and Smithers' heartbeat-based `cancelled`-vs-`failed` distinction.

### How to apply it to your own project

- **CI auto-repair pipeline.** Point the `implement` agent at a real failing test suite in your repo (fetched via the GitHub API or a local checkout). On each iteration, the agent patches the source files, the compute task runs your actual test command (`pytest`, `cargo test`, `jest`), and the loop exits when all tests pass. Gate merges on a `passed: true` result stored in SQLite.
- **Linter / type-error fix loop.** Replace `bun test` with `tsc --noEmit` or `eslint --max-warnings 0`. The agent reads the compiler output and applies targeted fixes; the loop exits when the tool exits zero. This is especially useful for automated dependency-upgrade PRs that break types.
- **Infra provisioning with verification.** Wrap a Terraform `apply` + `validate` pair in the loop. The agent interprets plan errors and adjusts `.tf` files; the compute task confirms the target resource is reachable before exiting. Kill-and-resume guarantees you never re-run a partially applied plan.
- **Data-quality ETL retry.** Swap the coding tools for data-transformation logic. The agent rewrites a failing SQL migration or transformation script; the compute task runs row-count and constraint checks. The durable resume is valuable here because data jobs are often interrupted by timeouts or quota limits.

# Durable "fix until tests pass" coding agent

> An AI agent that automatically fixes a TypeScript bug by looping until all tests go green — and survives process death via durable resume.

## In plain language

You hand it a file with a bug in it and a test suite that is currently failing. The AI reads the broken code, makes a fix, runs the tests, and if they still fail it tries again — up to five times — until every test passes. The real magic is the crash-recovery: if the program is killed mid-run, it can pick up exactly where it stopped without redoing any work it already finished. This solves the very common frustration of a long automated task being interrupted and having to start over from scratch.

**Teaches:** AnthropicAgent, Loop, Sequence, Task (compute), `createSmithers` output schemas, durability / resume, `ctx.latest`
**Prerequisites:** Bun ≥ 1.3 · `ANTHROPIC_API_KEY`

## What it demonstrates

The workflow starts with a deliberately broken `src/slugify.ts` (one character bug: `+` instead of `-`). An `AnthropicAgent` (claude-haiku-4-5) reads the source and tests, applies a fix, then a compute task runs `bun test` and parses the result. The `<Loop>` repeats this pair until `testResult.passed === true` or five iterations are exhausted. The sample also shows Smithers' durability guarantee: kill the process mid-run, resume with `--resume true`, and Smithers picks up exactly where it left off — no work is re-done.

## Build & run

```bash
bun install

export ANTHROPIC_API_KEY=sk-ant-...

# Confirm tests start RED (1 pass, 4 fail)
bun test src/slugify.test.ts

# Run the workflow
bunx --bun smithers-orchestrator up workflow.tsx --run-id uc1-fix-run-1

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

Clean run (`uc1-fix-run-1`) completes in one loop iteration (~24 s):

```
[00:00:00] → implement (attempt 1, iteration 0)
[00:00:24] ✓ implement (attempt 1)
[00:00:24] → run-tests (attempt 1, iteration 0)
[00:00:24] ✓ run-tests (attempt 1)
[00:00:24] ✓ Run finished
{"runId":"uc1-fix-run-1","status":"finished"}
```

Key SQLite rows after the run:

```
-- implement_result
uc1-fix-run-1|implement|0|Fixed the bug in src/slugify.ts by changing the replace pattern for spaces from '+' to '-' on line 22...|["src/slugify.ts"]

-- test_result
uc1-fix-run-1|run-tests|0|1|5|0
-- columns: run_id | node_id | iteration | passed | pass_count | fail_count
```

Resume demo `_smithers_attempts`:

```
uc1-resume-demo | implement | 0 | 1 | cancelled   ← the killed attempt
uc1-resume-demo | implement | 0 | 2 | finished    ← resumed, new attempt
uc1-resume-demo | run-tests | 0 | 1 | finished
```

## What it proves

Verified run `uc1-fix-run-1` (live, 2026-06-17):

- Tests start at **1 pass / 4 fail** and end at **5 pass / 0 fail** in a single loop iteration.
- The agent made a minimal, correct one-character fix (`+` → `-`) without touching the test file.
- Durable resume (run `uc1-resume-demo`): after a `kill -9`, Smithers marked attempt 1 as `cancelled` and created attempt 2 on resume — without re-executing already-finished work.

## How it works

`workflow.tsx` defines one top-level `<Loop id="fix-loop" until={isDone} maxIterations={5}>` containing a `<Sequence>` of two tasks:

1. **`implement` (Task + AnthropicAgent)** — haiku-4-5 with `read`, `write`, `edit`, and `bash` tools. Reads `src/slugify.ts` and `src/slugify.test.ts`, applies a fix, returns a structured `implementResult` (summary + files modified).

2. **`run-tests` (Task, compute)** — an `async () => {}` function that calls `execSync("bun test ...")`, parses the pass/fail counts from stdout, and returns a structured `testResult` (including `passed: boolean`).

The loop exit condition is evaluated at the top of each iteration via `ctx.latest(outputs.testResult, "run-tests")`. All output schemas are declared with `createSmithers(...)` and persisted to typed SQLite tables (`implement_result`, `test_result`) automatically.

## Key gotchas

1. **Use `ctx.latest`, not `ctx.outputMaybe`, for the loop exit condition.** `ctx.outputMaybe({ nodeId })` pins to iteration 0; inside a loop you need the highest-iteration result. `ctx.latest(outputs.table, nodeId)` returns it.

2. **Use `z.string()` for numeric counts, not `z.number()`.** Smithers maps `z.number()` to SQLite INTEGER, which silently truncates fractions and can cause type confusion. This sample stores `passCount` and `failCount` as strings to avoid surprises.

3. **Killed attempt → `cancelled`, not `failed`.** When the process is killed, Smithers marks the in-flight attempt as `cancelled` (heartbeat went stale). Resume creates a new attempt without consuming a retry slot — retries are for validation failures, not process death.

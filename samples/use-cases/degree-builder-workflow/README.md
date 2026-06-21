# degree-builder — a Smithers workflow that durably scaffolds a structured knowledge-base project

> Two AI agents research a topic and plan a learning ladder; five compute Tasks materialize a 42-file directory skeleton to disk — and a kill-and-resume proves that finished Tasks are never re-executed.

## In plain language

You give this workflow a tool or technology name (say, "redis"), and it automatically produces a ready-to-use folder of 42 structured files — research notes, a skill progression plan, and stub documents for each learning level — by calling an AI twice and then writing the results to disk. Think of it like hiring a librarian who reads everything about a topic, drafts a curriculum, and files every document in labeled folders, all while you wait about 90 seconds.

The more interesting trick is what happens if you pull the plug halfway through: when you restart with the same run ID, the workflow picks up exactly where it left off, skipping any steps that already finished. This solves a real headache in long-running AI pipelines — wasted time and money re-running expensive steps after a crash or timeout.

**Teaches:** AnthropicAgent, Task (compute), Sequence, structured output (Zod schemas), durability / resume, agent-to-compute data flow, `ctx.outputMaybe`, red→green env-gate pattern
**Prerequisites:** Bun ≥ 1.3 · `ANTHROPIC_API_KEY`

## What it demonstrates

Two `AnthropicAgent` tasks produce structured JSON — a capability map and an L0–L5 POC ladder — and downstream compute Tasks consume those outputs to write a complete, hierarchical directory tree to disk. The data-flow seam (agent JSON becoming file content) is exercised end-to-end. Killing the process mid-run and resuming with the same `--run-id` shows that already-finished Tasks (including both expensive Anthropic calls) are skipped entirely on resume, while only the cancelled Task reruns.

## Build & run

```bash
bun install

# A git commit is required before the first 'up' — Smithers hashes the workflow file
git init && git add -A && git commit -m "initial"

export ANTHROPIC_API_KEY=sk-ant-...

# Full scaffold run (~90s — two real Anthropic calls + file writes)
bunx --bun smithers-orchestrator up workflow.tsx \
  --input '{"target":"redis","category":"data-infrastructure","dirName":"01-cache-and-pubsub","outDir":"./scratch-out"}' \
  --format json
```

**Red/green env-gate** — run with writers disabled to prove the gate works:

```bash
DEGREE_BUILDER_RED=1 bunx --bun smithers-orchestrator up workflow.tsx \
  --input '{"target":"redis","category":"data-infrastructure","dirName":"01-cache-and-pubsub","outDir":"./scratch-out"}' \
  --format json
# research + plan succeed; write-metadata fails immediately; scratch-out absent
```

**Kill + resume (durability proof):**

```bash
# Start the run in the background
bunx --bun smithers-orchestrator up workflow.tsx \
  --input '{"target":"redis","category":"data-infrastructure","dirName":"01-cache-and-pubsub","outDir":"./scratch-out"}' \
  --format json &
RUN_PID=$!

# Capture the runId from `ps`, then poll until write-metadata finishes and kill
RUN_ID="<runId from: bunx --bun smithers-orchestrator ps>"
until [ "$(sqlite3 smithers.db "SELECT state FROM _smithers_attempts WHERE run_id='$RUN_ID' AND node_id='write-metadata';")" = "finished" ]; do sleep 2; done
kill -9 $RUN_PID

# Wait ~35s for heartbeat expiry; confirm stale state
bunx --bun smithers-orchestrator ps

# Resume with the same runId
bunx --bun smithers-orchestrator up workflow.tsx \
  --input '{"target":"redis","category":"data-infrastructure","dirName":"01-cache-and-pubsub","outDir":"./scratch-out"}' \
  --resume true --run-id $RUN_ID --format json
```

**Inspect results:**

```bash
# Run status
sqlite3 smithers.db "SELECT run_id, workflow_name, status FROM _smithers_runs;"

# Manifest (total files + dirs)
sqlite3 smithers.db "SELECT degree_root, total_files, total_dirs, smithers_run_id FROM manifest;"

# Attempt history — proves no double-execution
sqlite3 smithers.db "SELECT node_id, attempt, state FROM _smithers_attempts WHERE run_id='<runId>' ORDER BY node_id, attempt;"

# Generated file tree
find ./scratch-out/redis -type f | sort
```

## Expected output

A normal run prints one line per Task, approximately:

```
[00:00:00] → research (attempt 1, iteration 0)
[00:00:29] ✓ research (attempt 1)
[00:00:29] → plan (attempt 1, iteration 0)
[00:00:58] ✓ plan (attempt 1)
[00:00:58] → write-metadata (attempt 1, iteration 0)
[00:00:58] ✓ write-metadata (attempt 1)
[00:00:58] → write-research (attempt 1, iteration 0)
[00:01:18] ✓ write-research (attempt 1)
[00:01:18] → write-planning (attempt 1, iteration 0)
[00:01:18] ✓ write-planning (attempt 1)
[00:01:18] → write-stubs (attempt 1, iteration 0)
[00:01:18] ✓ write-stubs (attempt 1)
[00:01:18] → manifest (attempt 1, iteration 0)
[00:01:18] ✓ manifest (attempt 1)
[00:01:18] ✓ Run finished
```

The manifest SQLite row confirms 42 files and 14 directories:

```
sqlite3 smithers.db "SELECT degree_root, total_files, total_dirs FROM manifest;"
scratch-out/redis/degrees/01-cache-and-pubsub|42|14
```

## What it proves

GREEN run `31820dde` (status: `finished`) produced a complete 42-file skeleton at `scratch-out/redis/degrees/01-cache-and-pubsub/` with real `claude-sonnet-4-6` structured output (both Anthropic calls took ~29s each, confirmed by timestamps).

Durability run `cf728133` was killed after `write-metadata` completed and resumed from the same `run-id`. The attempt table shows:

```
research|1|finished
plan|1|finished
write-metadata|1|finished
write-research|1|cancelled   ← the killed attempt
write-research|2|finished    ← the resumed attempt
```

`research`, `plan`, and `write-metadata` each have exactly one attempt — they were not re-executed. The run finished with the same `run-id` and produced an identical 42-file tree.

## How it works

`workflow.tsx` composes a single `<Sequence>` of seven Tasks inside a `<Workflow>`:

1. **`research`** — `AnthropicAgent` (claude-sonnet-4-6) receives the target tool name and returns a Zod-validated JSON object: capability map, setup facts, known failure modes, credential needs.
2. **`plan`** — `AnthropicAgent` (claude-sonnet-4-6) receives the research output (via `ctx.outputMaybe`) and returns an L0–L5 POC ladder with a capstone description.
3. **`write-metadata`** — compute Task reads `researchOut` and writes 7 markdown files under `00-metadata/`.
4. **`write-research`** — compute Task writes 7 files under `01-research/`, including a capability-map table. Contains a `Bun.sleep(20000)` to create a reliable kill window for durability testing (remove in production).
5. **`write-planning`** — compute Task reads `planOut` and writes 8 files under `02-planning/`, including `poc-progression.md` with the full L0–L5 ladder.
6. **`write-stubs`** — compute Task creates `03-pocs/` (one subdirectory per POC level), `04-logs/`, and stub READMEs for `05-distillation/`, `06-skill-pack/`, `07-evaluation/`, plus the top-level `README.md`.
7. **`manifest`** — compute Task walks the output root and records `totalFiles`, `totalDirs`, and the Smithers `runId` as proof of completion.

All numeric outputs use `z.string()` (not `z.number()`) to avoid SQLite INTEGER truncation. Agent outputs are consumed downstream via `ctx.outputMaybe(outputs.research, { nodeId: "research" })`.

## Key gotchas

**1. Never name an output field `runId`, `nodeId`, or `iteration`.**
Smithers maps camelCase Zod fields to snake_case SQLite columns. Those three names are internal columns present on every output table; using them causes `duplicate column name: run_id` at startup. The workflow uses `smithersRunId` instead.

**2. Heartbeat expiry is ~35s after `kill -9` — do not resume immediately.**
The run stays in `status: running` for ~35s after the process dies. Attempting `--resume` before the heartbeat expires will be rejected. Poll `bunx --bun smithers-orchestrator ps` until you see `status: stale` before resuming.

**3. Use `z.string()` for all numeric output fields.**
`z.number()` causes Smithers to create an `INTEGER` SQLite column, which silently truncates decimal values and causes schema issues. Use `z.string()` and `String(value)` at the return site.

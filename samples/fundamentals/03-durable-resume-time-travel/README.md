# Durable kill+resume and time travel

> Kill a workflow mid-flight, resume it, and prove that finished tasks are never re-executed — then branch off a historical frame.

## TL;DR

This example runs two steps in sequence, then lets you force-quit the program while the second step is still sleeping. When you restart it, the orchestrator checks a local database file it keeps, sees that step one already finished, and picks up from step two — without re-doing any work. It is like power-cycling a dishwasher mid-cycle and having it resume from where it left off rather than starting over from scratch. The "time travel" part lets you branch off a snapshot taken right after step one, so you can re-run the rest of the workflow from that exact point — useful for replaying or debugging a long job without re-running the expensive parts you already trust.

**Teaches:** `Sequence`, `Task` (static + compute), `createSmithers`, durability, kill+resume, `timeline`, `fork` (time travel)
**Prerequisites:** Bun ≥ 1.3 · none (keyless)

## What it demonstrates

Two tasks run in sequence: `task-a-static` completes instantly and is persisted to SQLite, then `task-b-slow` starts a 60-second sleep. You SIGKILL the process mid-sleep, wait for the heartbeat to expire, and resume. Smithers skips `task-a-static` entirely (it is already `finished`) and re-runs `task-b-slow` as attempt 2. The `timeline` command shows the frame history, and `fork --frame 2` creates an independent branch from the point just after Task A finished — demonstrating Smithers' time-travel capability.

This matters because it proves the core durability guarantee: SQLite is the single source of truth. A completed task's output row is never discarded, and no resume can cause double-execution.

## Build & run

```bash
bun install

# Step 1: start the run with a stable run-id, let it run in background
bunx --bun smithers-orchestrator up durability.tsx --run-id "durable-demo" &
SMITHERS_PID=$!

# Step 2: wait until task-a-static is finished, then SIGKILL mid-Task-B
# (SIGTERM does NOT stop Bun — you must use kill -9)
while true; do
  STATE=$(sqlite3 smithers.db \
    "SELECT state FROM _smithers_nodes WHERE run_id='durable-demo' AND node_id='task-a-static';")
  [ "$STATE" = "finished" ] && break
  sleep 1
done
kill -9 $SMITHERS_PID

# Step 3: inspect pre-resume state
sqlite3 smithers.db \
  "SELECT node_id, state FROM _smithers_nodes WHERE run_id='durable-demo';"
# task-a-static | finished
# task-b-slow   | in-progress   (killed, no output row yet)

# Step 4: wait for heartbeat to expire (~35s), then resume
sleep 35
bunx --bun smithers-orchestrator up durability.tsx \
  --run-id "durable-demo" --resume true

# Step 5: view the frame timeline
bunx --bun smithers-orchestrator timeline durable-demo

# Step 6: fork from frame 2 (just after Task A finished)
bunx --bun smithers-orchestrator fork durability.tsx \
  --run-id durable-demo --frame 2 --label "fork-from-frame-2"

# Step 7: view timeline with fork tree
bunx --bun smithers-orchestrator timeline durable-demo --tree
```

> Note: Smithers requires a git repo in the working directory. Run `git init` first if you are working outside a git repo.

## Expected output

Resume CLI (task-a-static does not appear — it is skipped):

```
[00:00:00] → task-b-slow (attempt 2, iteration 0)
[00:01:00] ✓ task-b-slow (attempt 2)
[00:01:00] ✓ Run finished
runId: durable-demo
status: finished
```

Post-resume SQLite nodes:

```
task-a-static | state=finished | last_attempt=NULL   (1 attempt, never re-run)
task-b-slow   | state=finished | last_attempt=2      (attempt 1 cancelled, attempt 2 finished)
```

Timeline with fork tree:

```
durable-demo
  Frame 1  2026-06-17 14:16:38Z  3d1b0810
  Frame 2  2026-06-17 14:16:38Z  88f2fb2f
  |-- 01eb00fa-994 [fork-from-frame-2] (forked at frame 2)
  Frame 3  2026-06-17 14:17:55Z  05e3f954
  Frame 4  2026-06-17 14:17:55Z  6ad8a5b9
  Frame 5  2026-06-17 14:18:55Z  480d91d4
  Frame 6  2026-06-17 14:18:55Z  480d91d4
```

## How it works

`durability.tsx` defines a single `<Workflow>` containing a `<Sequence>` of two `<Task>` nodes:

- **`task-a-static`** — returns a plain object literal (static task). Smithers evaluates it at render time and persists the output immediately.
- **`task-b-slow`** — returns an async function that sleeps 60 seconds (compute task). This creates the kill window.

Task IDs are stable string literals (`"task-a-static"`, `"task-b-slow"`). Smithers matches persisted node state to these IDs on resume — if the IDs change, resume fails with `RESUME_METADATA_MISMATCH`.

On resume, Smithers loads the last persisted frame, replays the render, sees `task-a-static` is `finished`, skips it, and starts a fresh attempt for `task-b-slow`. Each attempt is a separate row in `_smithers_attempts`.

The `fork` command reads frame 2 (the delta recorded after Task A finished), copies that frame's content hash into a new run, and returns the child run ID. The fork starts paused — pass `--run` to execute it immediately, or resume it separately.

## Key gotchas

1. **SIGTERM does not stop Bun — use `kill -9`.** Sending SIGTERM to a Smithers process leaves it running normally. The process completes, and the run finishes as if nothing happened. Only SIGKILL guarantees an immediate stop.

2. **Wait 35+ seconds after SIGKILL before resuming.** After a SIGKILL the run remains `status=running` in `_smithers_runs`. Smithers uses a heartbeat; until that heartbeat goes stale (~30s), `--resume true` is rejected with `code: RUN_STILL_RUNNING`. The `--force` flag does NOT bypass this check.

3. **Do not modify `durability.tsx` between the initial run and resume.** Smithers stores a hash of the workflow source on first run. Any change to the file causes `--resume true` to be blocked with `code: RESUME_METADATA_MISMATCH`.

## What you'll learn & how to apply it

**What you'll learn**

This example teaches Smithers' core durability primitive: how a workflow's state is check-pointed to SQLite frame-by-frame so that a killed process can resume exactly where it left off — skipping completed tasks, retrying the interrupted one, and never double-executing finished work. It also covers time travel: forking a new run from any historical frame so you can replay or debug from a trusted mid-workflow checkpoint without re-running expensive earlier steps.

**How to apply it to your own project**

- **Long-running data pipelines.** Replace `task-b-slow` with a real ETL step (e.g. a large S3 export, a database migration, or a model fine-tune job). If the host crashes or you need to scale down, resume the run from the last finished step rather than re-running the whole pipeline from scratch.
- **Multi-stage CI/CD or build jobs.** Model each build stage (compile, test, deploy) as a `<Task>` in a `<Sequence>`. A transient infra failure mid-deploy lets you resume from the failed stage instead of re-running compile and test.
- **Debugging expensive workflows.** Use `fork --frame N` to branch off a snapshot taken just before the step you are iterating on. Tweak the task logic, replay only that tail of the workflow, and discard the fork — without burning time or money re-running the trusted upstream steps.
- **Audit and replay for compliance.** The frame timeline is a tamper-evident log of exactly what ran, when, and with what output. Point `timeline --tree` at a production run to reproduce the exact execution state at any point in time — useful for incident post-mortems or regulated workflows that require replay evidence.

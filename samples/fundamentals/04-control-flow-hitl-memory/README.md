# Parallel control flow + human-in-the-loop approval + cross-run memory

> A workflow fans out three tasks in parallel, pauses for a human approval gate, conditionally runs a gated task only after approval, then demonstrates that named facts written to the memory store survive across independent workflow runs.

**Teaches:** `Parallel` (maxConcurrency), `Sequence`, `Task`, `Approval` (HITL), `ctx.outputMaybe` conditional scheduling, `createMemoryStore`, durability (pause/resume), exit code 3
**Prerequisites:** Bun ≥ 1.3 · none (keyless — no LLM calls, all static tasks)

## What it demonstrates

`<Parallel maxConcurrency={2}>` with three children starts exactly two tasks concurrently; the third waits until a slot frees. An `<Approval>` node then halts the run cleanly (exit code 3, status `waiting-approval`) until a human (or script) calls `approve`. The gated task is conditionally rendered via `ctx.outputMaybe` — it is only scheduled after the approval decision is read back on resume. Finally, `createMemoryStore` from `smithers-orchestrator/memory` writes a named fact to `_smithers_memory_facts`; a second full workflow run confirms the row is unchanged, proving memory outlives individual runs.

## Build & run

```bash
bun install
```

**Step 1 — launch (pauses at the approval gate):**
```bash
bunx --bun smithers-orchestrator up workflow.tsx --input '{"name":"my-run"}' --format json
# Exits with code 3; prints the runId and status=waiting-approval
```

**Step 2 — inspect the paused run:**
```bash
bunx --bun smithers-orchestrator ps --status waiting-approval --format json
bunx --bun smithers-orchestrator inspect <runId> --format json
# Look for runState.blocked.kind="approval", nodeId="approve-gate"
```

**Step 3 — approve and resume:**
```bash
bunx --bun smithers-orchestrator approve <runId> --node approve-gate --by tester --format json
bunx --bun smithers-orchestrator up workflow.tsx --resume --run-id <runId> --format json
# Exits with code 0; gated-task now runs
```

**Step 4 — write a memory fact (cross-run proof):**
```bash
bun run write-memory.ts   # writes poc-fact, reads it back immediately
bun run read-memory.ts    # recalls via listFacts + raw SQLite dump
```

**Step 5 — run a second workflow to prove memory survives:**
```bash
bunx --bun smithers-orchestrator up workflow.tsx --input '{"name":"run2"}' --format json
# approve + resume as above, then:
sqlite3 smithers.db "SELECT namespace, key, value_json, created_at_ms, updated_at_ms FROM _smithers_memory_facts;"
# created_at_ms is identical across both runs — the row was not recreated
```

**Inspect task and approval rows:**
```bash
sqlite3 smithers.db "SELECT run_id, node_id, label, ts FROM task_a;"
sqlite3 smithers.db "SELECT run_id, node_id, label, ts FROM task_c;"
sqlite3 smithers.db "SELECT run_id, node_id, status, decided_by FROM _smithers_approvals;"
sqlite3 smithers.db "SELECT run_id, node_id, status, approved FROM gated_result;"
```

## Expected output

**After Step 1 (paused):** exit code 3, JSON with `"status": "waiting-approval"`.

**After Step 3 (resumed):** exit code 0; the `gated_result` table gains a row:
```
<runId>|gated-task|approved-and-ran|1
```

**Parallel timing** (verified run `3cfa3c18`): `task_a` and `task_b` share the same `ts` value; `task_c` has a later timestamp — confirming the concurrency cap of 2:
```
3cfa3c18...|task-a|parallel-A|2026-06-17T14:15:29.048Z
3cfa3c18...|task-b|parallel-B|2026-06-17T14:15:29.048Z
3cfa3c18...|task-c|parallel-C|2026-06-17T14:15:29.214Z
```

**Approvals table** after grant:
```
3cfa3c18...|approve-gate|approved|tester|
```

**Memory fact** (persists across both runs):
```
workflow:l3-control-hitl-memory|poc-fact|{"value":"L3 memory proof: ...","writtenAt":"..."}|1781705772232|1781705772232
```

## What it proves

Verified on runs `3cfa3c18-3d48-4a47-bbac-3528ac92896d` (primary) and `9ea263ec-8fcc-4bbe-aa69-07ad9e16cca0` (memory persistence):

- **Parallel concurrency cap is strict** — event stream shows `NodeStarted` for `task-a` and `task-b` at `+00:00.163`/`+00:00.164` (concurrent); `task-c` at `+00:00.181` (after both finished).
- **Approval pause/resume is clean** — `ApprovalRequested` at `+00:00.192`, `ApprovalGranted` at `+00:13.397`, `gated-task` started at `+00:17.811` — only after human action.
- **Memory outlives runs** — `created_at_ms=1781705772232` is identical in the `_smithers_memory_facts` row after both runs completed, confirming the store is persistent, not reset per run.

## How it works

`workflow.tsx` exports a single `smithers()` factory. On the first render the JSX tree is:

1. **`<Parallel maxConcurrency={2}>`** containing `task-a`, `task-b`, `task-c` — Smithers starts at most 2 at once.
2. **`<Approval id="approve-gate" onDeny="skip">`** — halts the run and emits exit code 3. The CLI `approve` command records the decision in `_smithers_approvals`.
3. **Conditional `<Task id="gated-task">`** — gated by `ctx.outputMaybe(outputs.gateDecision, { nodeId: "approve-gate" })`. On the initial render this returns `null` (no decision yet) so the node is not scheduled. On resume the reconciler re-renders with the persisted decision, sees a non-null value, and adds the task.
4. **`<Task id="memory-note">`** — a static task that records a timestamp string, confirming the sequence completed.

`write-memory.ts` and `read-memory.ts` are standalone Bun scripts that use `createMemoryStore` (imported from `smithers-orchestrator/memory`) against the same `smithers.db` file, demonstrating the store API independently of the workflow runtime.

All output shapes are declared up front with `createSmithers({ ... })` using Zod schemas; Smithers creates the corresponding SQLite tables automatically.

## Key gotchas

1. **Exit code 3 is not an error.** When a run reaches `waiting-approval`, the process exits with code 3 and prints JSON. This is the intended handoff; resume with `up <workflow> --resume --run-id <id>`.

2. **Conditional tasks require `ctx.outputMaybe`, not `ctx.output`.** Using `ctx.output` throws if the upstream node has not yet produced a result. `ctx.outputMaybe` returns `null` on the first render and the real value on resume — this is the correct pattern for tasks that depend on an `Approval` decision.

3. **`createMemoryStore` is a sub-path import.** Import from `"smithers-orchestrator/memory"`, not from `"smithers-orchestrator"` directly. The same applies to any memory processors.

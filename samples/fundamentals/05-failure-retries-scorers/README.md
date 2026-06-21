# Failure handling: retries, TryCatchFinally, event stream, scorers

> Shows how Smithers records failure history, routes to catch/finally branches, and attaches automated evaluators to agent tasks — the operational seams needed for unattended workflows.

**Teaches:** TryCatchFinally, retries, continueOnFail, AnthropicAgent, schemaAdherenceScorer, latencyScorer, event stream, `_smithers_attempts`, `_smithers_scorers`
**Prerequisites:** Bun ≥ 1.3 · `ANTHROPIC_API_KEY`

## What it demonstrates

A compute `Task` throws unconditionally with `retries={1}`, producing two rows in `_smithers_attempts` (initial attempt + one retry). Once retries are exhausted, the `TryCatchFinally` catch branch fires, followed by the finally branch — and the run finishes with status `finished` (failure absorbed). A second task attaches `schemaAdherenceScorer` and `latencyScorer` to an `AnthropicAgent` call, writing scorer results into `_smithers_scorers` and surfacing them via the `scores` CLI command. The 38-event stream (`NodeFailed`, `NodeRetrying`, `TokenUsageReported`, etc.) is queryable both from the CLI and from the raw NDJSON log on disk.

## Build & run

```bash
bun install
export ANTHROPIC_API_KEY=sk-...
bunx --bun smithers-orchestrator up workflow.tsx --input '{}'
```

### Inspect retry attempts

```bash
sqlite3 smithers.db \
  "SELECT node_id, attempt, state, error_json
   FROM _smithers_attempts
   ORDER BY started_at_ms;"
```

### Inspect the event stream

```bash
# All 38 events as NDJSON
bunx --bun smithers-orchestrator events <runId> --format jsonl

# Enriched per-node detail (token usage + scorer results)
bunx --bun smithers-orchestrator node scored-summary --run-id <runId> --format json
```

### Inspect scorer results

```bash
bunx --bun smithers-orchestrator scores <runId> --format json

sqlite3 smithers.db \
  "SELECT node_id, scorer_id, score, reason FROM _smithers_scorers;"
```

## Expected output

The workflow exits with status `finished`. The `_smithers_attempts` table contains five rows:

```
node_id           attempt  state     notes
failing-compute   1        failed    "Simulated compute failure for L5 retry demo"
failing-compute   2        failed    retries={1} = 2 total attempts
catch-handler     1        finished  TryCatchFinally catch branch fired
finally-cleanup   1        finished  finally always runs
scored-summary    1        finished  agent task with scorers
```

Scorer results (verified run `f4c65ae8`):

```json
{
  "scores": [
    {"node": "scored-summary", "scorer": "Schema Adherence", "score": "1.00", "reason": "Output matches schema"},
    {"node": "scored-summary", "scorer": "Latency",          "score": "1.00", "reason": "2184ms is within target (8000ms)"}
  ]
}
```

The event stream totals 38 `SmithersEvent` records for this run.

## What it proves

Verified run `f4c65ae8-c31e-44e3-ac17-b6630f001ce7` (status: `finished`):

- `retries={1}` produces exactly 2 `_smithers_attempts` rows for `failing-compute`, both `state=failed`.
- `TryCatchFinally` catch and finally branches both execute after retries exhaust; run-level status is `finished` — the failure is absorbed.
- `schemaAdherenceScorer` and `latencyScorer` each score `1.00` and appear in `_smithers_scorers` (2 rows).
- Token usage (`inputTokens: 282, outputTokens: 20`) is reported in the event stream via `TokenUsageReported` and accessible per-node via the `node` CLI command.

## How it works

`workflow.tsx` defines a `Sequence` containing two blocks:

1. **TryCatchFinally** — the `try` slot holds `failing-compute`, a compute `Task` that throws on every attempt (`retries={1}` triggers one retry). The `catch` slot holds `catch-handler` (a static `Task` with `continueOnFail` so a catch-task failure won't abort the workflow). The `finally` slot holds `finally-cleanup`, which always runs regardless of outcome.

2. **`scored-summary`** — an `AnthropicAgent` task using `claude-haiku-4-5` with two scorers declared in the `scorers` prop: `schemaAdherenceScorer()` (validates output against the Zod schema in-process, no LLM call) and `latencyScorer({ targetMs: 8000 })` (checks wall-clock duration). Results persist to `_smithers_scorers`.

The `createSmithers` call declares output schemas (`flaky_result`, `recovered`, `cleanup`, `scored`) with Zod, and each task references its output key so Smithers can validate and persist the result.

## Key gotchas

1. **Use the static ReactElement form for `catch`** — `catch={<Task .../>}` works; the function form `catch={(error) => <Task .../>}` does not fire in 0.24.2 and causes a `SCHEDULER_ERROR` (though `finally` still runs). The TypeScript types allow the function form, so there is no compile-time warning.

2. **`attempt` is 1-based in `_smithers_attempts`** — `retries={1}` means 1 retry on top of the initial attempt, producing rows with `attempt=1` and `attempt=2`. There is no `attempt=0`.

3. **`ScorerStarted`/`ScorerFinished` events do NOT appear in the NDJSON stream log** — scorer results are only accessible via `scores <runId>`, `node <nodeId> --run-id <runId> --format json`, or the `_smithers_scorers` SQLite table directly.

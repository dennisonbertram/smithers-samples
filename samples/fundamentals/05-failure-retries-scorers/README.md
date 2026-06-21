# Failure handling: retries, TryCatchFinally, event stream, scorers

> Shows how Smithers records failure history, routes to catch/finally branches, and attaches automated evaluators to agent tasks — the operational seams needed for unattended workflows.

## TL;DR

This example intentionally breaks a step, then watches the system recover: a task is set up to always fail, so you can see the retry fire, the "catch" handler run, and the "finally" cleanup run — just like try/catch/finally in ordinary code, but wired into a workflow that logs everything to a local database file. A second task asks an AI model a question and then automatically grades its own answer for correctness and speed, storing those scores alongside the result. If you're building any automated process that runs without a human watching — a nightly job, a data pipeline, an AI agent — this shows you how to make failures visible, recoverable, and measurable.

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

Scorer results (example):

```json
{
  "scores": [
    {"node": "scored-summary", "scorer": "Schema Adherence", "score": "1.00", "reason": "Output matches schema"},
    {"node": "scored-summary", "scorer": "Latency",          "score": "1.00", "reason": "2184ms is within target (8000ms)"}
  ]
}
```

The event stream totals 38 `SmithersEvent` records for this run.

## How it works

`workflow.tsx` defines a `Sequence` containing two blocks:

1. **TryCatchFinally** — the `try` slot holds `failing-compute`, a compute `Task` that throws on every attempt (`retries={1}` triggers one retry). The `catch` slot holds `catch-handler` (a static `Task` with `continueOnFail` so a catch-task failure won't abort the workflow). The `finally` slot holds `finally-cleanup`, which always runs regardless of outcome.

2. **`scored-summary`** — an `AnthropicAgent` task using `claude-haiku-4-5` with two scorers declared in the `scorers` prop: `schemaAdherenceScorer()` (validates output against the Zod schema in-process, no LLM call) and `latencyScorer({ targetMs: 8000 })` (checks wall-clock duration). Results persist to `_smithers_scorers`.

The `createSmithers` call declares output schemas (`flaky_result`, `recovered`, `cleanup`, `scored`) with Zod, and each task references its output key so Smithers can validate and persist the result.

## Key gotchas

1. **Use the static ReactElement form for `catch`** — `catch={<Task .../>}` works; the function form `catch={(error) => <Task .../>}` does not fire in 0.24.2 and causes a `SCHEDULER_ERROR` (though `finally` still runs). The TypeScript types allow the function form, so there is no compile-time warning.

2. **`attempt` is 1-based in `_smithers_attempts`** — `retries={1}` means 1 retry on top of the initial attempt, producing rows with `attempt=1` and `attempt=2`. There is no `attempt=0`.

3. **`ScorerStarted`/`ScorerFinished` events do NOT appear in the NDJSON stream log** — scorer results are only accessible via `scores <runId>`, `node <nodeId> --run-id <runId> --format json`, or the `_smithers_scorers` SQLite table directly.

## What you'll learn & how to apply it

**What you'll learn**

- How to wrap any fallible node in `TryCatchFinally` so a workflow absorbs failures gracefully instead of halting — the same try/catch/finally contract you already know, but durable and logged to SQLite.
- How `retries` controls total attempt count (not extra attempts), and how `_smithers_attempts` gives you a per-attempt audit trail for any node.
- How to attach `schemaAdherenceScorer` and `latencyScorer` to an agent task so every run self-evaluates and persists quality metrics alongside results — without a separate evaluation harness.

**How to apply it to your own project**

- **Resilient nightly jobs or data pipelines.** Wrap your ETL fetch step in `TryCatchFinally`: the `catch` branch sends a Slack alert or writes a dead-letter record, the `finally` branch closes the DB connection or releases a lock. Set `retries={2}` on the fetch node to tolerate transient API timeouts.
- **AI agent quality gates.** Add `schemaAdherenceScorer` to any `AnthropicAgent` task whose output must match a Zod schema (structured extraction, classification, slot-filling). If the score drops below 1.0 you know immediately — no manual spot-check needed.
- **SLA monitoring for LLM calls.** Attach `latencyScorer({ targetMs: <your P95 budget> })` to high-stakes agent nodes. Query `_smithers_scorers` over time to detect model or prompt regressions before users do.
- **Graceful degradation in multi-step pipelines.** Use `continueOnFail` on the `catch` task if your error-handler itself might fail (e.g., a secondary model call). The `finally` block then guarantees cleanup (temp-file deletion, span closure) runs regardless of how badly the primary path went.

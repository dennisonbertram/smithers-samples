# Resilient ETL saga with compensating rollback (live GitHub API)

> A durable data pipeline that fetches real commits, enriches them with LLM risk classification, loads a warehouse row, and automatically rolls it back if a downstream step fails — leaving the database in a clean, consistent state.

## TL;DR

This example pulls recent code commits from a real GitHub repository, asks an AI model to rate how risky the changes look, then writes that summary into a local database file. The interesting part is what happens when something goes wrong midway: instead of leaving the database in a half-updated mess, the pipeline automatically erases its own partial work — like a chef who cleans the cutting board before leaving if the dish has to be abandoned. This solves a common headache in data engineering where a failed step silently corrupts your records, forcing manual cleanup later.

**Teaches:** `Saga`, `Task` (compute + agent), `AnthropicAgent`, `Sequence`, `createSmithers` typed outputs, compensating transactions, durability
**Prerequisites:** Bun ≥ 1.3 · `ANTHROPIC_API_KEY` (GitHub API is keyless)

## What it demonstrates

A classic data-pipeline hazard: the load step succeeds but the downstream publish step fails, leaving the warehouse with a partially-ingested batch. This sample shows how the `Saga` primitive makes the fix mechanical — declare an `action` and a `compensation` per step; on failure, compensations run in reverse order for every step that already succeeded. The data-integrity invariant (`COUNT(*) = 0` for the rolled-back row) is directly observable in SQLite, making the guarantee verifiable rather than theoretical.

The sample also wires a real `AnthropicAgent` into the pipeline for LLM-powered commit risk classification, so you can see an AI task as one stage in a larger durable workflow.

## Build & run

```bash
bun install
export ANTHROPIC_API_KEY=sk-ant-...

# Failure path — triggers compensating rollback
bunx --bun smithers-orchestrator up workflow.tsx \
  --input '{"repo":"colinhacks/zod","failPublish":true}' --format json

# Capture the runId from the output, then verify the warehouse is clean:
sqlite3 smithers.db \
  "SELECT COUNT(*) FROM loaded_commits WHERE run_id='<YOUR_RUN_ID>' AND node_id='load-act';"
# expect: 0 (row was DELETEd by the compensation)

sqlite3 smithers.db \
  "SELECT node_id, loaded_count, rolled_back FROM loaded_commits WHERE run_id='<YOUR_RUN_ID>';"
# expect: only load-comp row with rolled_back=1, loaded_count=0

# Happy path — no compensation fires
bunx --bun smithers-orchestrator up workflow.tsx \
  --input '{"repo":"colinhacks/zod","failPublish":false}' --format json
```

Inspect any run:

```bash
# All attempts for a run
sqlite3 smithers.db \
  "SELECT node_id, attempt, state FROM _smithers_attempts WHERE run_id='<RUN_ID>' ORDER BY node_id;"

# LLM enrichment output
sqlite3 smithers.db \
  "SELECT repo, risk_level, summary, notable_shas FROM enrichment WHERE run_id='<RUN_ID>';"

# Full event stream (includes token usage)
bunx --bun smithers-orchestrator events <RUN_ID>
```

## Expected output

The run prints a JSON result and exits with status `finished` even when compensation fires — `onFailure="compensate"` is designed to resolve the saga gracefully.

Example output (failure path — `failPublish: true`):

```
# _smithers_runs
<run-id>|resilient-etl-saga|finished

# _smithers_attempts
enrich-commits|1|finished
fetch-commits|1|finished
load-act|1|finished
load-comp|1|finished
publish-act|1|failed

# loaded_commits — warehouse is clean after rollback
SELECT COUNT(*) ... WHERE node_id='load-act'  →  0
SELECT ... WHERE run_id='<run-id>'  →  load-comp|0|<run-id>|1
# (rolled_back=1, loaded_count=0)

# LLM enrichment (real commits from colinhacks/zod at run time)
risk_level: low
summary: "This batch contains documentation updates, configuration adjustments,
and gitignore changes... No functional code changes or breaking modifications."
notable_shas: 6f5e99fd,3fc9b25f

# Token usage (real Anthropic call)
enrich-commits  in=775  out=108
```

Happy path (`failPublish: false`): `loaded_count=5`, `rolled_back=0`, `published=1` — row preserved, no compensation.

## How it works

`workflow.tsx` exports a single `smithers()` workflow with three stages in a `Sequence`:

1. **fetch-commits** (`Task`) — calls `https://api.github.com/repos/<repo>/commits?per_page=5` with no auth token and stores real commit SHAs, messages, and authors into the typed `fetched_commits` output table.

2. **enrich-commits** (`Task` with `agent=enrichAgent`) — passes the raw commits to `claude-haiku-4-5` for risk classification. The agent returns a JSON object (`riskLevel`, `summary`, `notableShas`) stored in the `enrichment` table.

3. **ingest-saga** (`Saga` with `onFailure="compensate"`) — two steps in sequence:
   - `load`: action writes a row to `loaded_commits`; compensation DELETEs that row using a side-channel `bun:sqlite` connection keyed on `runId`.
   - `publish`: action either succeeds or throws an injected error (`failPublish` input); compensation is a no-op marker (nothing to undo since publish never completed).

All output tables are declared upfront via `createSmithers({ ... })` with Zod schemas. Smithers persists every task result to SQLite automatically.

## Key gotchas

1. **Throws in JSX children execute at render time, not task time.** If you write `{(() => { throw new Error(...) })()}` directly inside a `<Task>`, Smithers throws before it can register the task or trigger compensation. Always wrap the body in `async () => { ... }` so the error is thrown during execution, not rendering.

2. **`onFailure="compensate"` gives `status: finished`, not `status: failed`.** The data-integrity proof lives in the SQLite rows, not the run status. If you need a non-zero exit code for CI, use `onFailure="compensate-and-fail"`.

3. **Camelcase schema keys become snake_case column names.** `loadedCount` → `loaded_count`, `rolledBack` → `rolled_back`, `riskLevel` → `risk_level`. SQLite queries using camelCase column names will return "no such column". Run `.schema <table>` to confirm actual names before querying.

## What you'll learn & how to apply it

**What you'll learn**

The `Saga` primitive gives you declarative compensating transactions: each step declares an `action` and a `compensation`, and Smithers automatically runs compensations in reverse order for every step that already succeeded when a later step fails. This is the standard pattern for keeping distributed or multi-step data pipelines consistent without manual cleanup code — and it works even when the pipeline spans LLM enrichment, database writes, and external publish calls.

**How to apply it to your own project**

- **Event-driven ingestion pipeline.** Replace the GitHub commits fetch with a Kafka consumer or S3 event source. Keep the LLM enrichment stage for classification or summarization, swap the SQLite load for your real warehouse (Postgres, BigQuery, Snowflake), and use the compensation to `DELETE` or mark rows as `invalidated`. The rollback guarantee protects your warehouse from half-ingested batches when a downstream step (e.g., Pub/Sub publish, Slack notification, webhook delivery) fails.
- **Multi-step order fulfillment.** Model each step — reserve inventory, charge payment, dispatch shipment — as a `Saga` action with a compensation (release reservation, issue refund, cancel dispatch). If shipment dispatch fails after payment succeeds, compensations fire automatically in reverse, leaving the order in a clean pre-payment state without bespoke rollback logic.
- **AI-enriched data migration.** Use a `Saga` to migrate records from a legacy schema to a new one: action writes to the new table, compensation deletes the migrated row. Embed an LLM classification or transformation step between the read and write stages. If any record's transformation fails validation, the compensation removes partial writes so you can re-run the migration cleanly.
- **CI/CD deployment pipeline.** Model deploy stages (build artifact, push to registry, update service, run smoke test) as saga steps. If the smoke test fails, the compensation can roll back the service to its previous image tag. The `onFailure="compensate-and-fail"` option ensures the CI job exits non-zero even though Smithers resolves the saga gracefully.

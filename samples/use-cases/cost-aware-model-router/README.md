# Cost-aware model router — cheap-first routing with quality-gated escalation

> Route LLM tasks to the cheapest model that meets your quality bar, escalate only when the cheap answer fails.

## TL;DR

You give this workflow a list of questions or tasks. It tries each one with a cheap model first. A more capable model checks the answer; if it passes, you're done. Only when the cheap answer falls short does the workflow retry with a more expensive model, and it tracks exactly what each escalation cost.

**Teaches:** AnthropicAgent, Task (agent + compute + static), Branch (nested 3-way), Parallel, Sequence, ctx.outputMaybe, ctx.runId, llmJudge scorer, bun:sqlite event-stream query
**Prerequisites:** Bun ≥ 1.3 · `ANTHROPIC_API_KEY`

## What it does

Every incoming task is attempted by `claude-haiku-4-5` first, regardless of how the classifier ranked it. A `claude-sonnet-4-6` verifier checks the answer against a configurable quality bar (default `0.96`). Tasks that fall below the bar escalate to either `claude-sonnet-4-6` (moderate ceiling) or `claude-opus-4-8` (hard ceiling), with each escalation written as a durable record. After all items finish, a compute Task reads the live `_smithers_events` token-usage stream and produces a per-tier cost ledger in dollars.

## Build & run

```bash
bun install
export ANTHROPIC_API_KEY=sk-ant-...
bunx --bun smithers-orchestrator up workflow.tsx --format json
```

The default batch is three items: `easy-arith`, `summary`, and `hard-reasoning`. The default quality bar is `0.96`.

Adjust the quality bar to control escalation behaviour:

```bash
# Lower bar — all pass at haiku (demonstrates zero-escalation cost)
bunx --bun smithers-orchestrator up workflow.tsx --input '{"qualityBar":"0.5"}' --format json

# Higher bar — forces more escalations
bunx --bun smithers-orchestrator up workflow.tsx --input '{"qualityBar":"0.99"}' --format json
```

Inspect results after the run:

```bash
RUN_ID=<runId printed by the command above>

sqlite3 smithers.db "SELECT node_id, item_id, tier, routed_model FROM classification WHERE run_id='$RUN_ID';"
sqlite3 smithers.db "SELECT node_id, item_id, tier, quality_pass, score FROM verify_result WHERE run_id='$RUN_ID';"
sqlite3 smithers.db "SELECT * FROM escalation WHERE run_id='$RUN_ID';"
sqlite3 smithers.db "SELECT total_input_tokens, total_output_tokens, total_cost_usd, escalations FROM cost_ledger WHERE run_id='$RUN_ID';"

# Branch execution proof: pending = not-taken side, finished = executed
sqlite3 smithers.db "SELECT node_id, state FROM _smithers_nodes WHERE run_id='$RUN_ID' ORDER BY node_id;"

# llmJudge scorer scores per task
bunx --bun smithers-orchestrator scores $RUN_ID --format json
```

## Expected output

The run completes in roughly 15 seconds. With `qualityBar=0.96`, the `summary` item is the reliable escalation trigger: the haiku answer omits a key fact (Brazil's 60% share) and scores `0.95` — just below the bar — causing it to escalate to sonnet.

Example output:

**Classification**
| item | tier | routed_model |
|---|---|---|
| easy-arith | trivial | haiku |
| summary | moderate | sonnet |
| hard-reasoning | hard | opus |

**Verify results (haiku tier)**
| item | quality_pass | score |
|---|---|---|
| easy-arith | 1 | 1.00 |
| summary | 1 | 0.95 (below bar → escalates) |
| hard-reasoning | 1 | 1.00 |

**Cost ledger**
```
total_input_tokens | total_output_tokens | total_cost_usd | escalations
5778               | 709                 | 0.019137       | 1
```

Per-tier breakdown: haiku — 6 calls, $0.0044; sonnet — 5 calls, $0.0147; opus — 0 calls (hard item passed at haiku).

## How it works

`workflow.tsx` builds a per-item pipeline inside `buildItemPipeline()` and fans the items out via `<Parallel maxConcurrency={3}>`.

Each item pipeline is a `<Sequence>` of four stages:

1. **Classify** — a haiku `AnthropicAgent` assigns `trivial / moderate / hard` and a ceiling tier.
2. **Solve (haiku)** — haiku always attempts the task first; an `llmJudge` scorer records supplemental quality scores to `_smithers_scorers`.
3. **Verify (haiku)** — a sonnet verifier computes `qualityPass` and a numeric `score`.
4. **Escalation Branch** — nested `<Branch if/then/else>` implements the 3-way decision:
   - `cheapPass` (qualityPass AND score ≥ qualityBar) → `then={null}` (no escalation)
   - ceiling = `"hard"` → escalate to opus
   - otherwise → escalate to sonnet

After all parallel pipelines complete, a single compute **Task** opens `smithers.db` in read-only mode via `bun:sqlite`, queries `_smithers_events` for all `TokenUsageReported` rows belonging to `ctx.runId`, maps each nodeId prefix to a tier, and writes the aggregated cost ledger to the `cost_ledger` table.

`ctx.outputMaybe()` is used throughout to read upstream task outputs within the same render cycle — Smithers re-renders the workflow tree as tasks complete, so these reads correctly pick up values once their producing tasks have finished.

## Key gotchas

**`model` field in `TokenUsageReported` events is `"unknown"` on 0.24.2.**
Every event in `_smithers_events` has `payload_json.model = "unknown"`. Cost attribution by model name is impossible — you must attribute by nodeId prefix instead. The workflow's `getTier(nodeId)` function handles this.

**Compute Task children must be a function reference, not an IIFE.**
The pattern is `{async () => { return row; }}`. Writing `{(async () => { return row; })()}` evaluates immediately and passes a `Promise` as the Task's children, which Smithers rejects with `Task output failed validation — expected string, received undefined`.

**Schema fields named `nodeId` conflict with Smithers' system column.**
Smithers writes a `node_id` column to every output table. If your Zod schema includes a field called `nodeId`, it maps to the same column and the run fails with `duplicate column name: node_id`. Use a different name (e.g., `taskId`) for any application-level id field.

## What you'll learn & how to apply it

**What you'll learn**

This example teaches the cheap-first escalation pattern: try the lowest-cost model first, score the result against a configurable quality bar, and promote to a more capable model only on failure. The key primitives are nested `<Branch>` for the multi-way escalation decision, `llmJudge` for numeric quality scoring, and a compute `Task` that reads the live `_smithers_events` token-usage stream to produce a real cost ledger. The pattern generalises to any task where a capable-but-expensive model is the last resort, not the default.

**How to apply it to your own project**

- **Support ticket triage:** Replace the demo questions with your real support tickets fetched from an API. Route simple, FAQ-style queries to a haiku-class model and escalate only when the answer scores below your confidence threshold — dramatically cutting per-ticket inference cost.
- **RAG answer generation:** Feed document-grounded Q&A through the same cheap-first pipeline. Tune `qualityBar` based on downstream metrics (user thumbs-down rate, escalation rate) rather than a fixed number, and add a hard budget cap (`maxCost`) that stops escalation once a run-level dollar limit is reached.
- **Batch content moderation:** Pass candidate content items in parallel through a small classifier first; escalate ambiguous cases (score near the decision boundary) to a stronger model for a second opinion. The durable escalation records give you an audit trail for every moderation decision.
- **Code generation quality gate:** Use the verifier stage to run a lightweight static-analysis or unit-test pass on haiku-generated code before deciding whether to escalate to sonnet or opus. Pair with the `llmJudge` scorer to capture structured feedback (correctness, style, security) alongside the pass/fail decision.

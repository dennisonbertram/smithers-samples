# Gotchas (smithers-orchestrator 0.24.x)

## Setup

- **Use `zod@^4`.** Smithers introspects schemas via Zod v4 internals; a v3 schema fails with
  `undefined is not an object (evaluating 'schema._zod.def')`.
- **No `react` dependency needed.** On 0.24 the minimal dep set is
  `{ smithers-orchestrator, zod }`. Don't add `react`.
- **Run with `bunx --bun smithers-orchestrator`** — the bare `bunx smithers` resolves an unrelated
  npm package. The tsconfig needs `"jsxImportSource": "smithers-orchestrator"` (or a
  `/** @jsxImportSource smithers-orchestrator */` pragma atop the `.tsx`).

## Agents & schemas

- **Model id: `claude-haiku-4-5` (not `claude-fable-5`).** The wrong model surfaces as a misleading
  *"the agent did not return valid JSON for the declared output schema"* error rather than a
  model-not-found error.
- **`z.number()` → SQLite `INTEGER` and truncates decimals** (`0.95` → `0`/`1`). Use **`z.string()`**
  for fractional values like a confidence or cost. `z.boolean()` persists as `INTEGER` `0`/`1`.
- **Reserved output-field names collide with internal columns.** A Zod output field named
  `nodeId`, `runId`, or `iteration` collides with Smithers' own columns (duplicate-column / silent
  errors). Rename them — e.g. `taskId`, `smithersRunId`, `revNum`.
- **`AnthropicAgent` does native structured output by default.** On 0.24.2 this became *opt-in* for
  the `OpenAIAgent` / `CodexAgent` / `HermesAgent` — pass `nativeStructuredOutput: true` for pure
  structured output on those. `AnthropicAgent` is unchanged.

## Control flow

- **`<Branch>` is `if` / `then` / `else` props**, not children:
  `<Branch if={cond} then={<Task/>} else={<Task/>} />`. Only the rendered side executes.
- **`SagaStep` is type-only at the package root** — importing `<SagaStep>` throws
  *"Export named 'SagaStep' not found"*. Use the `steps` prop:
  `<Saga onFailure="compensate" steps={[{ id, action: <Task/>, compensation: <Task/> }]} />`.
  To trigger compensation, make a later step's `action` throw with `retries={0}`; earlier steps'
  `compensation` tasks run, and `onFailure="compensate"` lets the **run still finish** — assert
  on the *data* state, not the run status. A no-op compensation silently leaves dirty state.
- **An `<Approval>` gate makes `up` exit with code 3.** That's the *paused* state, not a failure.
  Approve with `approve <runId> --node <id> --by <name>`, then `up --resume --run-id <id>`. Gated
  downstream tasks must render conditionally: `{decision ? <Task/> : null}`.
- **Inside a `<Loop>`, read the latest iteration with `ctx.latest(outputs.x, nodeId)`** —
  `ctx.outputMaybe(…, { nodeId })` returns iteration 0, so a loop exit condition built on it never
  advances.

## Durability

- **`git init` + one commit before the first `up`.** Without a commit the `workflow_hash` is null
  and resume fails with `RESUME_METADATA_MISMATCH`. Don't edit the workflow file between a kill and
  a resume.
- **Kill Bun with `kill -9`** — it ignores `SIGTERM`. After a kill, the run shows `running` until
  the heartbeat goes stale (~35s); wait before resuming. A killed attempt is recorded as
  `cancelled`, and resume starts a fresh attempt without re-running finished tasks.

## Observability

- **Scorer results are not in the event/NDJSON stream.** Read them from `_smithers_scorers`, the
  `scores <runId>` CLI, or `node <runId> <nodeId>`.
- **`TokenUsageReported.model` is `"unknown"`** on 0.24.x — you can't attribute per-model cost from
  the event's `model` field; attribute by the task/node id instead.

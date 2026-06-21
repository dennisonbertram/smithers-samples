# Concepts — the Smithers mental model

Smithers is a **durable AI workflow orchestrator** implemented as a **JSX/TSX runtime**. It is a
React-style reconciler whose host elements are *tasks*, not DOM nodes. The loop is:

> **render → extract ready tasks → execute → persist to SQLite → re-render**

Every step is checkpointed to SQLite, so a run is *durable*: kill it and resume without
redoing finished work, fork it at any past frame (time travel), pause it for human approval, and
read its full history back out of the database.

## Defining a workflow

```tsx
import { createSmithers, Sequence, Task } from "smithers-orchestrator";
import { z } from "zod";

const { Workflow, smithers, outputs } = createSmithers({
  greeting: z.object({ message: z.string() }),   // each key → a SQLite table
});

export default smithers((ctx) => (
  <Workflow name="hello">
    <Sequence>
      <Task id="greet" output={outputs.greeting}>{{ message: `Hello, ${ctx.input.name}` }}</Task>
    </Sequence>
  </Workflow>
));
```

- **`createSmithers({ name: schema })`** registers each Zod schema as a SQLite **table** and gives
  you a typed `outputs.<name>` reference.
- **`smithers((ctx) => …)`** is the workflow factory. `ctx.input` is the parsed `--input` JSON;
  `ctx.output(outputs.x, { nodeId })` / `ctx.outputMaybe(…)` read a finished task's output;
  `ctx.latest(outputs.x, nodeId)` reads the most recent iteration (use this inside loops).

## The three Task modes

| Mode | Child | Runs when | Example |
|---|---|---|---|
| **static** | object literal `{{ field: value }}` | at render time | a constant or input-derived value |
| **compute** | `async () => ({ … })` | at execution time | a fetch, a DB read, a shell command |
| **agent** | a prompt string + `agent={…}` | at execution time | an LLM call, Zod-validated |

Task ids **must be stable** across renders — durability matches finished rows to nodes by id.

## Agents & structured output

```tsx
import { AnthropicAgent } from "smithers-orchestrator";
const agent = new AnthropicAgent({ model: "claude-haiku-4-5", instructions: "…" });
<Task id="classify" agent={agent} output={outputs.classification} retries={1}>{prompt}</Task>
```

`AnthropicAgent` injects the output Zod schema and validates the response → the validated row is
persisted. On a validation miss it retries up to `retries` times. Use
**`claude-haiku-4-5` / `claude-sonnet-4-6` / `claude-opus-4-8`**.

## Control-flow primitives (used in these samples)

| Primitive | Purpose |
|---|---|
| `<Sequence>` | run children in order |
| `<Parallel maxConcurrency={n}>` | fan out, bounded concurrency |
| `<Branch if={bool} then={…} else={…}>` | run exactly one side |
| `<Loop until={cond} maxIterations={n}>` | iterate a body until done |
| `<Approval id … onDeny="skip">` | pause for a human decision (process exits **code 3**) |
| `<Saga steps={[{ id, action, compensation }]} onFailure="compensate">` | compensating transactions / rollback |
| `<Timer duration="1s" />` | a durable delay |
| `<TryCatchFinally try={…} catch={…} finally={…} />` | failure handling (use the element form of `catch`) |

## Durability & time travel

- Every task attempt, event, and frame is written to SQLite (`_smithers_runs`, `_smithers_nodes`,
  `_smithers_attempts`, `_smithers_events`, `_smithers_frames`, …).
- A killed/failed task attempt is recorded as **`cancelled`**; **resume** (`up --resume --run-id`)
  creates a fresh attempt and **skips finished tasks**.
- Resume requires the workflow source to be **unchanged** (a stable `workflow_hash`), so commit the
  file before the first run.
- `timeline`, `fork`, `replay`, `rewind` let you inspect and branch from any past frame.

## Human-in-the-loop, memory, scorers

- **Approval** gates pause a run (`up` exits **code 3** — that's success, not failure); a human runs
  `approve <runId> --node <id> --by <name>`, then you `up --resume`.
- **Memory** persists facts across runs via `createMemoryStore` (imported from
  `smithers-orchestrator/memory`); CLI `memory list` is read-only.
- **Scorers** (`schemaAdherenceScorer`, `latencyScorer`, `llmJudge` from
  `smithers-orchestrator/scorers`) attach to a Task and write to `_smithers_scorers` / `scores`.

## Beyond these samples

Smithers also ships an **HTTP serving layer** (`up --serve`), a multi-run **Gateway** control
plane, an **MCP** server (`--mcp`), an **observability** stack (`observability`, OTLP →
Prometheus/Grafana/Tempo), and a custom remote **`SandboxProvider`** interface for offloading
execution to remote runtimes (e.g. Cloudflare Workers). Those need extra setup (a cloud account or
Docker) and aren't included here to keep every sample reproducible with just Bun + a key.

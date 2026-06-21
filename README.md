# Smithers Samples

A collection of **runnable, real-world sample workflows** for [Smithers](https://smithers.sh) —
a durable AI workflow orchestrator authored as a **JSX/TSX runtime**. You write workflows as
components (`<Task>`, `<Parallel>`, `<Approval>`, `<Saga>`, …); Smithers renders them, executes
the ready tasks, and **checkpoints every step to SQLite** so a run can be killed and resumed,
time-traveled, paused for human approval, and observed — without a server or a cloud account.

Every sample here was **built and run live** (real model calls / real APIs, no mocks) and each
folder's README cites the real `runId` it was verified with. Start with the fundamentals, then
explore the use-cases.

```bash
git clone https://github.com/dennisonbertram/smithers-samples
cd smithers-samples/samples/fundamentals/01-hello-smoke
bun install
bunx --bun smithers-orchestrator up workflow.tsx --input '{"name":"world"}'
sqlite3 smithers.db "SELECT * FROM hello;"   # -> <runId>|greet|0|Hello, world
```

## Prerequisites

- **[Bun](https://bun.sh) ≥ 1.3** — Smithers runs on Bun (`bunx --bun smithers-orchestrator …`).
- **git** — Smithers uses a VCS for durable worktrees (a `git init` + one commit before the first run).
- **`ANTHROPIC_API_KEY`** — only for samples that call an agent. Use model **`claude-haiku-4-5`**
  (the samples already do). The fundamentals marked *keyless* need no key at all.

> Each sample is self-contained: `cd` into it, `bun install`, and run. No monorepo wiring.

## Fundamentals — the core ladder

| Sample | Teaches | Needs key? |
|---|---|---|
| [`01-hello-smoke`](samples/fundamentals/01-hello-smoke) | The render→execute→persist loop; a Task's output lands in SQLite | — keyless |
| [`02-agent-structured-output`](samples/fundamentals/02-agent-structured-output) | An `AnthropicAgent` Task with a Zod schema → validated JSON persisted | ✅ |
| [`03-durable-resume-time-travel`](samples/fundamentals/03-durable-resume-time-travel) | Kill a run mid-flight, resume without redoing finished work; timeline + fork | — keyless |
| [`04-control-flow-hitl-memory`](samples/fundamentals/04-control-flow-hitl-memory) | `<Parallel>` fan-out, a human-in-the-loop `<Approval>` gate, cross-run memory | — keyless |
| [`05-failure-retries-scorers`](samples/fundamentals/05-failure-retries-scorers) | Retries, `<TryCatchFinally>`, the event stream, and scorers | ✅ |
| [`06-eval-harness`](samples/fundamentals/06-eval-harness) | Run an eval suite against a live model with red→green tests | ✅ |

## Use-cases — real-world workflows

| Sample | What it does | Needs key? |
|---|---|---|
| [`cost-aware-model-router`](samples/use-cases/cost-aware-model-router) | Routes each task to the cheapest sufficient model and **escalates** only on quality fail, with a real $/token cost ledger | ✅ |
| [`multi-agent-code-review`](samples/use-cases/multi-agent-code-review) | Three reviewer agents (correctness/security/style) + a judge, gated by a **human approval** before "posting" | ✅ |
| [`content-quality-loop`](samples/use-cases/content-quality-loop) | Draft → judge-score → revise in a **`<Loop>`** until the quality bar is met | ✅ |
| [`resilient-etl-saga`](samples/use-cases/resilient-etl-saga) | Fetch from a live public API → enrich → load, with a **`<Saga>`** that rolls back on failure | ✅ |
| [`degree-builder-workflow`](samples/use-cases/degree-builder-workflow) | A Smithers workflow that **durably scaffolds a whole project**, survivable across a crash | ✅ |
| [`durable-fix-until-green`](samples/use-cases/durable-fix-until-green) | An agent that reads failing tests and fixes code **until they pass**, resumable | ✅ |

## Suggested path

1. **See it work** → `01-hello-smoke` (no key needed).
2. **Add an LLM** → `02-agent-structured-output`.
3. **Make it durable** → `03-durable-resume-time-travel`, then `04-control-flow-hitl-memory`.
4. **Handle failure** → `05-failure-retries-scorers`, `06-eval-harness`.
5. **Build something real** → any of the use-cases. `cost-aware-model-router` and
   `multi-agent-code-review` are the best showcases of Smithers' strengths.

## How each sample is structured

```
<sample>/
  README.md        # what it teaches, how to run, expected output, what it proves
  workflow.tsx     # the workflow (some samples add helpers/tests/fixtures)
  package.json     # pins smithers-orchestrator@0.24.2 + zod@^4
  tsconfig.json    # jsxImportSource: "smithers-orchestrator"
```

## Conventions & doctrine

- **Live, no mocks.** Every sample hits a real service (a real model call, a real public API).
  READMEs cite the real `runId` they were verified with.
- **Pinned.** `smithers-orchestrator@0.24.2`, `zod@^4`, Bun ≥ 1.3.
- New to the framework? Read [`docs/concepts.md`](docs/concepts.md) for the mental model and
  [`docs/gotchas.md`](docs/gotchas.md) for the pitfalls that cost the most time.

## Learn more

- 📖 [`docs/getting-started.md`](docs/getting-started.md) — install Bun, set your key, run your first sample
- 🧠 [`docs/concepts.md`](docs/concepts.md) — the Smithers mental model + every primitive used here
- ⚠️ [`docs/gotchas.md`](docs/gotchas.md) — 0.24.x pitfalls, each verified live
- 🔗 [Smithers](https://smithers.sh) · [`smithers-orchestrator` on npm](https://www.npmjs.com/package/smithers-orchestrator)

## License

MIT — see [LICENSE](LICENSE).

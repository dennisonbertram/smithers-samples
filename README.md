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

## TL;DR — what each example does

New to Smithers? Here's each sample in one sentence. Every sample folder also has its own
**TL;DR** up top and a **"What you'll learn & how to apply it"** section at the bottom — so you
can see both what it does and how to reuse the pattern in your own projects.

**Fundamentals — learn the engine**
- **[01-hello-smoke](samples/fundamentals/01-hello-smoke)** — Pass in a name, get a greeting back, and confirm the result is automatically saved to a local file — the "does it even run?" check you do first.
- **[02-agent-structured-output](samples/fundamentals/02-agent-structured-output)** — Feed a news article to an AI and get back a clean, structured classification (category, sentiment, topics, summary) saved to disk — no manual JSON wrangling.
- **[03-durable-resume-time-travel](samples/fundamentals/03-durable-resume-time-travel)** — Force-quit a workflow mid-run and restart it: finished steps are skipped and only the unfinished work re-runs — completed work is never lost or repeated.
- **[04-control-flow-hitl-memory](samples/fundamentals/04-control-flow-hitl-memory)** — Run several tasks at once, pause for a human to click "approve," then continue — and remember facts across separate runs.
- **[05-failure-retries-scorers](samples/fundamentals/05-failure-retries-scorers)** — Make a workflow survive failure gracefully: retry a broken step, run cleanup handlers, and automatically grade an AI task's output for correctness and speed.
- **[06-eval-harness](samples/fundamentals/06-eval-harness)** — Run a list of test cases against a live AI workflow and save a pass/fail report, so you catch regressions before they reach production.

**Use-cases — real-world workflows**
- **[cost-aware-model-router](samples/use-cases/cost-aware-model-router)** — Try each task on the cheapest AI model first and only escalate to a pricier one when the cheap answer fails a quality check — then report exactly what that saved you.
- **[multi-agent-code-review](samples/use-cases/multi-agent-code-review)** — Send a code change to three AI reviewers at once, have a judge AI combine their findings, and require a human to approve before anything is "posted."
- **[content-quality-loop](samples/use-cases/content-quality-loop)** — An AI writer and an AI editor take turns on a draft, revising until the writing scores above your quality bar (or it runs out of tries).
- **[resilient-etl-saga](samples/use-cases/resilient-etl-saga)** — Fetch real GitHub commits, have an AI rate their risk, save the results — and automatically clean up its own partial writes if anything fails midway.
- **[degree-builder-workflow](samples/use-cases/degree-builder-workflow)** — Give it a topic and it researches, plans, and writes a whole multi-folder knowledge-base project to disk — and picks up where it left off if interrupted.
- **[durable-fix-until-green](samples/use-cases/durable-fix-until-green)** — An AI fixes a broken file by running the tests in a loop until they all pass, and can resume right where it left off if the process is killed.

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

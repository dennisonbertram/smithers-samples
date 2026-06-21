# Getting started

These samples run on [Bun](https://bun.sh). Smithers itself needs **no account** — only the
samples that call an LLM need an `ANTHROPIC_API_KEY`.

## 1. Install Bun (≥ 1.3)

```bash
curl -fsSL https://bun.sh/install | bash
bun --version   # 1.3.x or newer
```

You also need **git** on your PATH — Smithers uses a VCS to create durable worktrees.

## 2. (Optional) Set your Anthropic key

Samples that use an agent read `ANTHROPIC_API_KEY` from the environment:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

The samples call **`claude-haiku-4-5`** (cheap and fast). The keyless fundamentals
(`01-hello-smoke`, `03-durable-resume-time-travel`, `04-control-flow-hitl-memory`) need nothing.

## 3. Run your first sample

```bash
cd samples/fundamentals/01-hello-smoke
bun install                       # installs smithers-orchestrator@0.24.2 + zod
bunx --bun smithers-orchestrator up workflow.tsx --input '{"name":"world"}'
```

You should see the run finish with a `runId`, and the output is persisted to SQLite:

```bash
sqlite3 smithers.db "SELECT * FROM hello;"
# <runId>|greet|0|Hello, world
```

That's the whole loop: Smithers **rendered** the workflow, **executed** the task, and
**persisted** the result to `./smithers.db`.

## 4. Useful commands

Every sample uses the same CLI (`bunx --bun smithers-orchestrator <cmd>`):

| Command | What it does |
|---|---|
| `up <file> [--input '{...}']` | Start a run (add `-d` to detach) |
| `ps` | List runs and their status |
| `inspect <runId>` | Full run state |
| `events <runId>` | The event stream (NDJSON) |
| `node <runId> <nodeId>` | One task's detail (incl. token usage, scorers) |
| `scores <runId>` | Scorer results |
| `approve <runId> --node <id> --by <name>` | Grant a human-approval gate |
| `up <file> --resume --run-id <id>` | Resume a killed/paused run |

Inspect the database directly any time: `sqlite3 smithers.db ".tables"` and
`sqlite3 smithers.db "SELECT * FROM <table>;"`. Each schema you declare with
`createSmithers({ name: zodSchema })` becomes a table named `name`.

## 5. Troubleshooting

- **`undefined is not an object (evaluating 'schema._zod.def')`** → you're on Zod v3. Smithers
  needs **`zod@^4`** (the samples pin it).
- **`... did not return valid JSON for the declared output schema`** → almost always the wrong
  model. Use **`claude-haiku-4-5`**, not `claude-fable-5`.
- **`RESUME_METADATA_MISMATCH`** → run `git init && git add -A && git commit -m init` in the
  sample folder *before* the first `up`, and don't edit the workflow file between a kill and a resume.
- **Resume rejected right after a kill** → the previous run's heartbeat is still "fresh." Wait
  ~35s, then resume. (And kill Bun with `kill -9` — it ignores `SIGTERM`.)

More pitfalls, each verified live: [`gotchas.md`](gotchas.md).

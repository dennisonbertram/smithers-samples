# Hello Smithers — CLI smoke + SQLite persistence

> Run a minimal TSX workflow end-to-end and confirm Smithers persists every task result to SQLite.

**Teaches:** Workflow, Sequence, Task, outputs schema (Zod), SQLite persistence, `smithers up` CLI
**Prerequisites:** Bun ≥ 1.3 · none (keyless)

## What it demonstrates

A single `<Task>` inside a `<Sequence>` accepts a string input, produces a typed output, and writes the result to a local `smithers.db`. This is the minimal proof that the Smithers runtime executes TSX workflows and that durability is on by default — no configuration required. It also surfaces the React dependency seam: the runtime uses React under the hood, so local `bun install` (not a bare `bunx`) is required to avoid invalid-hook-call errors.

## Build & run

```bash
bun install
bunx --bun smithers-orchestrator up workflow.tsx --input '{"name":"World"}'

# inspect the persisted result:
sqlite3 smithers.db "SELECT * FROM hello;"
```

## Expected output

The CLI prints the workflow completion and the task output. The `hello` table in `smithers.db` holds the persisted row:

```
# CLI (approximate)
✔ greet  { message: 'Hello, World' }

# SQLite
runId        taskId  output
-----------  ------  -------------------------
33c1e1ed...  greet   {"message":"Hello, World"}
```

Verified output: run `33c1e1ed` (runId prefix from a live execution against smithers-orchestrator 0.24.2).

## What it proves

Smithers executes a pinned TypeScript/TSX workflow from the CLI and writes every task result to SQLite without any remote provider or API key. Verified in run `33c1e1ed` on smithers-orchestrator 0.24.2.

## How it works

`workflow.tsx` calls `createSmithers` with a Zod output schema (`hello: z.object({ message: z.string() })`), then exports a `smithers()` factory that renders a `<Workflow>` tree:

```
<Workflow name="hello">
  └─ <Sequence>
       └─ <Task id="greet" output={outputs.hello}>
            {{ message: `Hello, ${ctx.input.name}` }}
          </Task>
```

The runtime renders the JSX tree, executes each node, and persists results to the `hello` table in `smithers.db`. `ctx.input` carries the `--input` JSON parsed at startup.

## Key gotchas

1. **Run `bun install` before `bunx --bun smithers-orchestrator up`** — skipping local install causes a React invalid-hook-call error because `bunx` may resolve a different React copy than the one Smithers expects.
2. **The SQLite table name matches the `<Workflow name>` prop** — here `name="hello"` creates the `hello` table. Change the name and the table changes.
3. **`--bun` flag is required** — `bunx smithers-orchestrator` without `--bun` runs under Node, which may not resolve Bun-specific module paths correctly; always use `bunx --bun`.

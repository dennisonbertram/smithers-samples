# Hello Smithers — CLI smoke + SQLite persistence

> Run a minimal TSX workflow end-to-end and watch Smithers persist the result to SQLite.

## TL;DR

Pass in a name, get a greeting back. Every result is saved to a local database file you can query later — no API key, no cloud account.

**Teaches:** Workflow, Sequence, Task, outputs schema (Zod), SQLite persistence, `smithers up` CLI
**Prerequisites:** Bun ≥ 1.3 · none (keyless)

## What it does

A single `<Task>` inside a `<Sequence>` accepts a string input, produces a typed output, and writes the result to a local `smithers.db`. Durability is on by default — no config needed. It also surfaces the React dependency seam: the runtime uses React under the hood, so local `bun install` (not a bare `bunx`) is required to avoid invalid-hook-call errors.

## Build & run

```bash
bun install
bunx --bun smithers-orchestrator up workflow.tsx --input '{"name":"World"}'

# inspect the persisted result:
sqlite3 smithers.db "SELECT * FROM hello;"
```

## Expected output

```
# CLI (approximate)
✔ greet  { message: 'Hello, World' }

# SQLite
runId        taskId  output
-----------  ------  -------------------------
<run-id>...  greet   {"message":"Hello, World"}
```

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

## What you'll learn & how to apply it

**What you'll learn**

The core Smithers primitive: wrap work in a `<Task>` and every result is automatically persisted to SQLite. Define the output shape with Zod, do the work inside the Task, get persistence for free. Every other Smithers workflow builds on this.

**How to apply it to your own project**

- **Replace the greeting with a real computation.** Swap `{ message: \`Hello, ${ctx.input.name}\` }` for any pure function — document parsing, JSON transformation, a local model call — and you get a persisted, auditable record of every invocation with no extra plumbing.
- **Use the SQLite table as a cheap job log.** In a CLI tool or batch script, treat the auto-created table as your job history: query it after a run to confirm which inputs succeeded, diff outputs across runs, or feed failed rows back as retry inputs.
- **Chain multiple Tasks for a multi-step pipeline.** Wrap two or more Tasks in a `<Sequence>` (e.g., fetch → parse → validate) and each step's output lands in its own named table, giving you a step-by-step audit trail without a database migration.
- **Use this as the integration smoke test in CI.** A stripped-down "hello" workflow that asserts a known output is the fastest sanity check that a Smithers upgrade or environment change hasn't broken the runtime. Run it in CI before heavier workflow tests.

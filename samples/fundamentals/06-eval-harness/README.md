# Eval harness — run a suite against a live model with red→green tests

> Run a JSON test suite against a live Smithers workflow and assert the results with a TDD red→green cycle.

## TL;DR

You write a list of test cases — each one says "send this input to the AI workflow and expect the output to contain this" — and then run a single command that fires real model calls, checks every case, and saves a structured results file. The idea is the same as unit tests for regular code: run before your change to confirm things are broken (red), make your change, run again to confirm they pass (green). This is especially useful when your AI workflow's behavior might drift over time — you keep a repeatable record that the model actually said what you expected.

**Teaches:** AnthropicAgent, Task, Sequence, `smithers eval`, eval cases (`outputContains`), eval report shape, TDD red→green
**Prerequisites:** Bun ≥ 1.3 · `ANTHROPIC_API_KEY`

## What it demonstrates

Smithers ships a built-in `eval` command that runs a JSON case file against a workflow, fires real model calls, and writes a structured JSON report. This sample shows a complete red→green cycle: `red.test.ts` asserts the report does not exist yet, `smithers eval` executes the suite and writes the report, then `green.test.ts` asserts the report is present and structurally valid. The pattern is directly reusable for regression-guarding any Smithers workflow.

## Build & run

```bash
bun install

# 1. Confirm RED state (report absent — 2 tests pass)
bun test red.test.ts

# 2. Run the eval suite against the live model
export ANTHROPIC_API_KEY=sk-ant-...
bunx --bun smithers-orchestrator eval workflow.tsx \
  --cases eval-cases.json \
  --suite greeting-eval \
  --report .smithers/evals/greeting-eval.json \
  --force \
  --format json

# 3. Confirm GREEN state (report written and valid — 5 tests pass)
bun test green.test.ts

# Inspect the written report
cat .smithers/evals/greeting-eval.json
```

## Expected output

`smithers eval` prints a JSON summary to stdout and writes the full report to `.smithers/evals/greeting-eval.json`. After a successful run the report looks like:

```json
{
  "suiteId": "greeting-eval",
  "runLabel": "20260101120000-a1b2c3d4",
  "durationMs": 2072,
  "summary": { "total": 2, "passed": 2, "failed": 0, "byStatus": { "finished": 2 } },
  "results": [
    {
      "caseId": "greet-alice-english",
      "status": "finished",
      "passed": true,
      "assertions": [
        { "name": "status", "passed": true },
        { "name": "outputContains", "passed": true,
          "actual": { "greeting": [{ "message": "Hello Alice! Nice to meet you.", "language": "English" }] }
        }
      ]
    },
    {
      "caseId": "greet-carlos-spanish",
      "status": "finished",
      "passed": true,
      "assertions": [
        { "name": "status", "passed": true },
        { "name": "outputContains", "passed": true,
          "actual": { "greeting": [{ "message": "¡Hola Carlos! ¿Cómo estás?", "language": "Spanish" }] }
        }
      ]
    }
  ]
}
```

`bun test green.test.ts` follows with: `5 pass, 0 fail`.

## How it works

`workflow.tsx` defines a single-task workflow: a `<Task id="greet">` inside a `<Sequence>`, backed by `AnthropicAgent({ model: "claude-haiku-4-5" })`. The task output is typed with Zod (`z.object({ message, language })`).

`eval-cases.json` lists two cases. Each case supplies an `input` object (passed to the workflow as `ctx.input`) and an `expected` block with two assertions:
- `status: "finished"` — the run must reach the finished state.
- `outputContains` — a deep-partial containment check against the stored output rows.

`smithers eval` runs each case as an isolated workflow execution, checks assertions, and writes the report. `red.test.ts` and `green.test.ts` use `bun:test` to bracket the eval step, making the TDD cycle visible and automatable.

## Key gotchas

1. **`outputContains` must match the stored row shape, not the raw Zod shape.** Task outputs are stored as an array of row objects: `{ "greeting": [{ "language": "English" }] }`, not `{ "greeting": { "language": "English" } }`. A plain object causes the assertion to always fail silently.

2. **`--force` is required to overwrite an existing report.** Without it the CLI exits immediately with `INVALID_INPUT` if the report file already exists. Always pass `--force` when re-running the same suite.

3. **`--report` is the flag for the output path; `--output` is a global CLI format flag.** They are easy to confuse. Use `--report <path>` (or `-r`) to control where the JSON report is written.

## What you'll learn & how to apply it

**What you'll learn**

This sample teaches the Smithers eval harness pattern: how to define a JSON case file with input/expected pairs, run `smithers eval` to fire real model calls, and bracket the whole cycle with red/green test assertions. The transferable skill is regression-guarding any Smithers workflow — you get a repeatable, automatable record that the model behaves as expected, and you can add it to CI like any other test suite.

**How to apply it to your own project**

- **Regression-guard a production workflow.** Replace the greeting workflow with your real workflow (e.g., a document classifier or ticket router). Write cases that cover your critical paths and edge cases, commit the `eval-cases.json` alongside the workflow, and run `smithers eval` in CI on every PR.
- **Catch prompt-drift over time.** Pin a `runLabel` from a known-good eval report and diff new reports against it. When a model update or prompt edit changes output, the `outputContains` assertions fail before users notice.
- **Multi-language or multi-locale validation.** Extend the case file with one entry per supported locale or input variant. The eval runner fires them in parallel, so you get full coverage without writing per-locale test code.
- **Integrate with a test runner gate.** Wire `green.test.ts` into your existing `bun test` / `vitest` suite so a broken eval report blocks the build — the same way a failing unit test does for regular code.

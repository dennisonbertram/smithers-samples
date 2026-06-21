# Agent Task with Zod-validated structured output

> Feed a news article to Claude, get back a validated structured object, and save the typed result to SQLite — all in a single `<Task>`.

## TL;DR

You pass in raw article text. The workflow asks Claude to return a structured "form" — category, sentiment, confidence score, key topics, and a one-sentence summary. The framework validates that response against a Zod schema before saving the row to a local database file. You get machine-readable data out of a language model without writing any parsing glue.

**Teaches:** `AnthropicAgent`, `Task` (structured output), `Sequence`, `createSmithers` output schemas, durability (SQLite persistence)
**Prerequisites:** Bun ≥ 1.3 · `ANTHROPIC_API_KEY`

## What it does

A news article classifier receives raw article text via `ctx.input.text` and produces five typed fields — `category`, `sentiment`, `confidence`, `key_topics`, and `summary` — validated against a Zod schema before the workflow finishes. The Smithers runtime injects the schema into the prompt, validates the agent's JSON response, and persists the result to a SQLite table named after the schema key (`classification`). If validation fails, the task retries up to the configured limit before the run fails.

## Build & run

```bash
bun install

export ANTHROPIC_API_KEY=sk-...

# Run with a technology article
bunx --bun smithers-orchestrator up workflow.tsx \
  --input '{"text":"OpenAI released GPT-5 today, marking a major breakthrough in artificial intelligence research. The new model shows unprecedented reasoning capabilities and could transform the tech industry."}' \
  --format json

# Run with a sports article
bunx --bun smithers-orchestrator up workflow.tsx \
  --input '{"text":"The local soccer team lost 0-3 in their championship final yesterday, disappointing thousands of fans who had traveled to support them."}' \
  --format json

# Inspect persisted output rows
sqlite3 smithers.db "SELECT * FROM classification;"

# Run metadata
sqlite3 smithers.db "SELECT run_id, workflow_name, status FROM _smithers_runs ORDER BY started_at_ms;"

# Attempt details (attempt column shows retries needed)
sqlite3 smithers.db "SELECT run_id, node_id, state, attempt FROM _smithers_attempts ORDER BY started_at_ms;"
```

If a run gets stuck (e.g. wrong model id triggering repeated retries), cancel it:

```bash
bunx --bun smithers-orchestrator down --force
```

## Expected output

Both runs complete on the first attempt in 1–4 seconds. Example output for the technology article:

```
<run-id>-...|classify-article|0|technology|positive|0.92|["OpenAI","GPT-5","artificial intelligence"]|OpenAI released GPT-5, a breakthrough AI model with unprecedented reasoning capabilities that could transform the technology industry.
```

The sports article run produces:

```
<run-id>-...|classify-article|0|sports|negative|0.95|["soccer","championship final","team loss"]|The local soccer team suffered a devastating 0-3 defeat in the championship final, disappointing their traveling supporters.
```

The `_smithers_runs` table shows `status=finished` and `_smithers_attempts` shows `attempt=1` for both — no retries needed.

## How it works

`createSmithers({ classification: z.object({...}) })` in `workflow.tsx` does three things at once: registers a SQLite table named `classification`, derives the TypeScript type for that table, and provides the `outputs.classification` reference used on the `<Task output={...}>` prop. When the workflow runs, the single `<Task>` inside the `<Sequence>` calls `classifyAgent` (an `AnthropicAgent` wrapping `claude-haiku-4-5`), passes the article text as its prompt body, and lets the runtime handle schema injection, validation, and persistence. The `retries={1}` prop means a validation failure gets one retry before the run errors.

## Key gotchas

1. **Use `z.string()` for float fields, not `z.number()`.** Smithers maps `z.number()` to a SQLite `INTEGER` column, so a confidence value of `0.9` is stored as `1`. The schema in this sample uses `z.string()` for `confidence` to preserve decimal precision (e.g. `"0.92"`).

2. **Model id errors surface as JSON validation failures, not `model-not-found`.** If the model name is wrong (e.g. `claude-fable-5`), Smithers receives no output from the API and reports: `Task "classify-article" expected structured JSON output, but the agent/model did not return valid JSON`. The root cause is `AI_NoOutputGeneratedError`. Use `claude-haiku-4-5`.

3. **Always `bun install` first and use `bunx --bun smithers-orchestrator`.** Running via a global `bunx` without a local install can pull in conflicting package versions and produce a React invalid-hook-call error. The `--bun` flag ensures Bun's resolver uses the locally installed version.

## What you'll learn & how to apply it

**What you'll learn**

Declare a Zod schema once with `createSmithers` output schemas, and the runtime handles prompt injection, JSON validation, retry on bad output, and SQLite persistence. No parsing or validation glue required. This pattern applies any time you need a language model to produce machine-readable data reliably.

**How to apply it to your own project**

- **Document or form extraction.** Swap the news article for invoices, support tickets, or legal clauses. Define a schema with the fields you need (vendor, amount, due date, priority level), point the `AnthropicAgent` at your document text, and the classified rows land directly in your database — no regex or post-processing needed.
- **API response enrichment.** Wrap calls to external APIs (GitHub issues, Jira tickets, customer feedback) in a `<Task>` that asks Claude to tag, score, or summarize each item. The Zod schema enforces that every row has the same shape before it hits your downstream pipeline.
- **Content moderation or triage.** Replace the classifier fields with `risk_level`, `category`, and `requires_human_review`. Feed in user-generated content and let the workflow accumulate a typed moderation queue in SQLite; a separate worker reads the table and routes flagged rows.
- **LLM-assisted data migration.** Use the structured output pattern to extract and normalize data from legacy free-text fields — the retries prop means a single ambiguous row doesn't abort the whole batch, and the `_smithers_attempts` table gives you an audit trail of which rows needed retries.

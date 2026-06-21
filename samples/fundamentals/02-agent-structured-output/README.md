# Agent Task with Zod-validated structured output

> Drive a live Claude call, validate its JSON response against a Zod schema, and persist the typed result to SQLite — all in a single `<Task>`.

## In plain language

You feed in a raw news article, and the workflow asks Claude to read it and fill out a structured "form" — category, sentiment, confidence score, key topics, and a one-sentence summary. The framework checks that Claude's answer actually matches that form (right fields, right types) before saving the completed row to a local database file. This solves a very common AI problem: getting a language model to reliably return machine-readable data instead of free-form prose you'd have to parse yourself.

**Teaches:** `AnthropicAgent`, `Task` (structured output), `Sequence`, `createSmithers` output schemas, durability (SQLite persistence)
**Prerequisites:** Bun ≥ 1.3 · `ANTHROPIC_API_KEY`

## What it demonstrates

A news article classifier receives raw article text via `ctx.input.text` and produces five typed fields — `category`, `sentiment`, `confidence`, `key_topics`, and `summary` — validated against a Zod schema before the workflow finishes. The Smithers runtime injects the schema into the prompt automatically, validates the agent's JSON response, and persists the result to a SQLite table named after the schema key (`classification`). If validation fails, the task retries up to the configured limit before the run fails — no manual error handling required.

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

Both runs complete on the first attempt in 1–4 seconds. The `classification` table row for the technology article (verified run `56cda949`):

```
56cda949-...|classify-article|0|technology|positive|0.92|["OpenAI","GPT-5","artificial intelligence"]|OpenAI released GPT-5, a breakthrough AI model with unprecedented reasoning capabilities that could transform the technology industry.
```

The sports article run (verified run `5be7eef2`) produces:

```
5be7eef2-...|classify-article|0|sports|negative|0.95|["soccer","championship final","team loss"]|The local soccer team suffered a devastating 0-3 defeat in the championship final, disappointing their traveling supporters.
```

The `_smithers_runs` table shows `status=finished` and `_smithers_attempts` shows `attempt=1` for both — no retries needed.

## What it proves

Two live runs on Smithers 0.24.2 (`56cda949`, `5be7eef2`) confirmed end-to-end: a real Anthropic API call (`claude-haiku-4-5`) returns JSON, the runtime validates it against the declared Zod schema, and the typed row lands in SQLite. Both runs succeeded on the first attempt. The `agentEngine: "anthropic-sdk"` field in the attempt record confirms native Anthropic structured output was used, not a workaround.

## How it works

`createSmithers({ classification: z.object({...}) })` in `workflow.tsx` does three things at once: registers a SQLite table named `classification`, derives the TypeScript type for that table, and provides the `outputs.classification` reference used on the `<Task output={...}>` prop. When the workflow runs, the single `<Task>` inside the `<Sequence>` calls `classifyAgent` (an `AnthropicAgent` wrapping `claude-haiku-4-5`), passes the article text as its prompt body, and lets the runtime handle schema injection, validation, and persistence. The `retries={1}` prop means a validation failure gets one retry before the run errors — fast feedback during development.

## Key gotchas

1. **Use `z.string()` for float fields, not `z.number()`.** Smithers maps `z.number()` to a SQLite `INTEGER` column, so a confidence value of `0.9` is stored as `1`. The schema in this sample uses `z.string()` for `confidence` to preserve decimal precision (e.g. `"0.92"`).

2. **Model id errors surface as JSON validation failures, not `model-not-found`.** If the model name is wrong (e.g. `claude-fable-5`), Smithers receives no output from the API and reports: `Task "classify-article" expected structured JSON output, but the agent/model did not return valid JSON`. The root cause is `AI_NoOutputGeneratedError`. Use `claude-haiku-4-5` (live-verified).

3. **Always `bun install` first and use `bunx --bun smithers-orchestrator`.** Running via a global `bunx` without a local install can pull in conflicting package versions and produce a React invalid-hook-call error. The `--bun` flag ensures Bun's resolver uses the locally installed version.

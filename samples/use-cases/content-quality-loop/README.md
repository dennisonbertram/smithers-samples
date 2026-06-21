# Content pipeline with a quality-gate loop

> One AI agent writes a draft; a second AI agent scores it. The loop repeats until the score clears a threshold or a maximum number of attempts is reached.

## TL;DR

Give the workflow a writing brief and a quality bar (default: 85 out of 100). A writer agent produces a draft; a judge agent scores it and returns specific notes on what to fix. If the score is too low, the writer revises and the judge scores again — automatically — until the score passes or `maxIterations` is exhausted. Every draft and critique are saved to a local SQLite database so you can inspect the full revision history afterward.

**Teaches:** `Loop` (until + maxIterations + onMaxReached), `Sequence`, `Task`, `AnthropicAgent`, `ctx.latest`, `llmJudge` scorer, SQLite output tables, scorer observability side-channel  
**Prerequisites:** Bun ≥ 1.3 · `ANTHROPIC_API_KEY`

## What it does

A writer agent produces a content draft against a brief. A judge agent scores it 0–100 and returns structured feedback. The `Loop` primitive repeats the write→judge cycle until the score clears a configurable threshold (default 85) or `maxIterations` is reached. Each iteration's draft and critique land in separate SQLite tables, giving you a complete revision history. An `llmJudge` scorer runs as an async observability side-channel, writing to `_smithers_scorers` independently of the control-flow gate — separate from the score the loop uses to decide whether to continue.

## Build & run

```bash
cd samples/use-cases/content-quality-loop
bun install
export ANTHROPIC_API_KEY=...
bunx --bun smithers-orchestrator up workflow.tsx --format json
```

Run with a lower threshold (easier to pass, fewer iterations):

```bash
bunx --bun smithers-orchestrator up workflow.tsx --input '{"threshold":80}' --format json
```

Run with a custom brief:

```bash
bunx --bun smithers-orchestrator up workflow.tsx \
  --input '{"threshold":85,"brief":{"topic":"...","audience":"...","requiredPoints":["point a","point b"],"tone":"professional","maxWords":200}}' \
  --format json
```

Inspect results after the run (replace `<runId>` with the ID printed at startup):

```bash
# Score trajectory across iterations
sqlite3 smithers.db "SELECT iteration, score, passed, coverage FROM critique WHERE run_id='<runId>' ORDER BY iteration;"

# Draft revisions with change notes
sqlite3 smithers.db "SELECT iteration, rev_num, title, word_count, change_note FROM draft WHERE run_id='<runId>' ORDER BY iteration;"

# Scorer side-channel (separate from control-flow scores)
bunx --bun smithers-orchestrator scores <runId> --format json

# Events including token usage
bunx --bun smithers-orchestrator events <runId> --format jsonl | grep -i "NodeFinished\|TokenUsage\|RunFinished"
```

## Expected output

The workflow logs each iteration as it runs, then exits when `passed=1`. For the default brief at threshold 85, expect 2–4 iterations. Example output:

```
# critique table — ascending score trajectory
sqlite3 smithers.db "SELECT iteration, score, passed FROM critique WHERE run_id='<runId>' ORDER BY iteration;"
0|72|0
1|82|0
2|88|1
```

```
# draft table — change notes show genuine revision
sqlite3 smithers.db "SELECT iteration, rev_num, word_count, change_note FROM draft WHERE run_id='<runId>' ORDER BY iteration;"
0|1|212|initial draft
1|2|194|Removed redundant headline, added specific ROI case study (bakery, $12,000 savings)...
2|3|197|Added third objection, clarified case study, linked satisfaction to revenue impact.
```

Total run time: ~31 seconds. Total tokens: ~9,005 (all `claude-haiku-4-5`).

## How it works

`workflow.tsx` defines two `AnthropicAgent` instances — `writer` and `judge` (both `claude-haiku-4-5`) — and a third agent (`scorerJudgeAgent`) used only by the `llmJudge` scorer.

The JSX tree is:

```
<Workflow name="content-quality-gate">
  <Loop id="quality-loop" until={isDone} maxIterations={4} onMaxReached="return-last">
    <Sequence>
      <Task id="write" agent={writer} output={outputs.draft} />
      <Task id="judge" agent={judge} output={outputs.critique} scorers={{...}} />
    </Sequence>
  </Loop>
</Workflow>
```

On each render, `ctx.latest(outputs.critique, "judge")` reads the most recent critique row (not a fixed snapshot) to compute `isDone = passed === true || score >= threshold`. When `isDone` is false, Smithers re-renders and advances the loop; when true, the run exits. The `write` task receives the previous draft and critique as prompt context so the writer knows exactly what to fix.

`createSmithers` declares the output schemas (`draft`, `critique`) upfront; Smithers creates the SQLite tables automatically, with `iteration` as an internal column tracking loop pass number.

## Key gotchas

**`iteration` is a reserved column name.** Smithers adds `run_id`, `node_id`, and `iteration` to every output table automatically. Defining a field named `iteration` in your `z.object()` schema causes a "duplicate column name" SQLite error on startup. Rename user-facing iteration fields (this sample uses `revNum`).

**`scorers` prop expects `{ scorer: Scorer }`, not a bare `Scorer`.** `llmJudge(config)` returns a `Scorer`. Passing it directly as a map value produces a runtime error (`"undefined is not an object (evaluating 'scorer.id')"`) on every attempt, burning API calls before failing. Wrap it: `{ "llm-quality": { scorer: llmJudge(...) } }`.

**Scorers are async observability, not control-flow.** The `llmJudge` scorer writes to `_smithers_scorers` after the task completes. For the final passing iteration the scorer row may not be written before the run exits — this is expected. Scorer scores and judge task scores are separate signals; do not use scorer output to gate the loop.

## What you'll learn & how to apply it

**What you'll learn**

This sample teaches the write→evaluate→revise loop pattern: how to use Smithers' `Loop` primitive with a dynamic exit condition, how to pass structured feedback between tasks so each iteration builds on the last, and how to separate observability signals (scorers) from control-flow gates. The reusable technique is any multi-pass refinement where a second agent acts as a gatekeeper with a numeric quality bar.

**How to apply it to your own project**

- **Marketing copy or documentation review:** Replace the demo brief with a real content spec from your CMS or ticket system. Set the threshold to match your editorial bar (e.g., 90 for customer-facing copy) and swap `claude-haiku-4-5` for a stronger model on the judge side only — keeping the writer on haiku controls cost.
- **Code generation with lint/test feedback:** Replace the writer agent with a code-generation prompt and the judge with a structured linter or test-runner that returns a pass/fail score. The loop exits when all checks pass or `maxIterations` is exhausted, giving you an automated "fix until green" code agent.
- **Structured data extraction with validation:** Use the loop to extract fields from messy input and validate completeness each pass. The judge prompt checks for missing required fields and returns a score based on fill rate; the writer re-reads the source and fills gaps until the schema is satisfied.
- **Email or support-response drafting:** Point the brief at a real support ticket (fetched via API) and tune the judge to score on tone, accuracy, and policy compliance. The loop prevents sending a first draft that fails a compliance check, automatically requesting a revision before any human review step.

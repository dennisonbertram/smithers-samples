# Content pipeline with a quality-gate loop

> An AI writer revises a content draft until a separate AI judge scores it above a threshold — proving multi-iteration refinement with a durable loop.

## In plain language

You give this workflow a writing brief (topic, audience, required points) and a quality bar (say, a score of 85 out of 100). One AI agent writes a draft; a second AI agent reads it and scores it like a tough editor, giving a numeric grade and specific notes on what to fix. If the draft falls short, the writer sees the critique and tries again — automatically — until the score clears the bar or a maximum number of attempts is reached. Every draft and every critique get saved to a local database file so you can replay the whole revision history afterward. This is the pattern to reach for when a single AI pass isn't good enough and you want the system to self-correct until the output meets a defined standard.

**Teaches:** `Loop` (until + maxIterations + onMaxReached), `Sequence`, `Task`, `AnthropicAgent`, `ctx.latest`, `llmJudge` scorer, SQLite output tables, scorer observability side-channel  
**Prerequisites:** Bun ≥ 1.3 · `ANTHROPIC_API_KEY`

## What it demonstrates

A writer agent produces a content draft against a brief; a judge agent scores it 0–100 and returns structured feedback. The `Loop` primitive repeats the write→judge cycle until the score clears a configurable threshold (default 85) or `maxIterations` is reached. Each iteration's draft and critique land in separate SQLite tables, giving you a complete revision history. An `llmJudge` scorer runs as an async observability side-channel, writing to `_smithers_scorers` independently of the control-flow gate — showing the distinction between evaluation signals and workflow control.

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

The workflow logs each iteration as it runs, then exits when `passed=1`. For the default brief at threshold 85, expect 2–4 iterations. Verified output for run `e835d4c6`:

```
# critique table — ascending score trajectory
sqlite3 smithers.db "SELECT iteration, score, passed FROM critique WHERE run_id='e835d4c6-c12d-4614-92b3-5b97dd0448fc' ORDER BY iteration;"
0|72|0
1|82|0
2|88|1
```

```
# draft table — change notes show genuine revision
sqlite3 smithers.db "SELECT iteration, rev_num, word_count, change_note FROM draft WHERE run_id='e835d4c6-c12d-4614-92b3-5b97dd0448fc' ORDER BY iteration;"
0|1|212|initial draft
1|2|194|Removed redundant headline, added specific ROI case study (bakery, $12,000 savings)...
2|3|197|Added third objection, clarified case study, linked satisfaction to revenue impact.
```

Total run time: ~31 seconds. Total tokens: ~9,005 (all `claude-haiku-4-5`).

## What it proves

Verified run `e835d4c6-c12d-4614-92b3-5b97dd0448fc` (smithers-orchestrator@0.24.2, Bun 1.3.14) shows three distinct loop iterations (0, 1, 2) with scores 72 → 82 → 88. The writer genuinely incorporated editor feedback each pass — iteration 1 added a missing ROI case study that the judge had flagged, lifting the score from 72 to 82; iteration 2 addressed remaining objection coverage, reaching 88 and exiting. This is the multi-pass refinement path, not a one-shot exit.

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

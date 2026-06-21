# Multi-agent code review with a human approval gate

> Three specialist AI reviewers fan out in parallel, a judge synthesizes their findings, and a human must approve before any review is posted — all in one durable, resumable workflow.

**Teaches:** `AnthropicAgent`, `Parallel`, `Sequence`, `Task`, `Approval` (HITL), conditional rendering, `ctx.outputMaybe`, durability / resume-without-replay
**Prerequisites:** Bun ≥ 1.3 · `ANTHROPIC_API_KEY`

## What it demonstrates

A realistic AI code-review pipeline stages four concerns in sequence: three `AnthropicAgent` tasks run in parallel (correctness, security, style), a fourth judge agent synthesizes their structured outputs into a single ranked verdict, and then an `Approval` gate pauses the run until a human explicitly approves or denies. Only after approval does the post-review task execute — and on resume, Smithers skips every already-finished task, so the four LLM calls are never replayed.

This is the shape of a production AI code-review bot: parallel specialist agents, a synthesis layer, a durable human checkpoint, and an auditable post-action record regardless of outcome.

## Build & run

```bash
cd samples/use-cases/multi-agent-code-review
bun install
export ANTHROPIC_API_KEY=sk-ant-...

# Stage 1 — fan-out + synthesis + gate (pauses at HITL, exits code 3)
bunx --bun smithers-orchestrator up workflow.tsx --format json
echo "exit=$?"   # expect 3 — this is correct, not an error

# Capture the runId printed in the JSON output, then check status
bunx --bun smithers-orchestrator ps --format json

# Inspect specialist reviews in SQLite
sqlite3 smithers.db "SELECT reviewer, recommendation FROM correctness_review WHERE run_id='<runId>';"
sqlite3 smithers.db "SELECT reviewer, recommendation FROM security_review WHERE run_id='<runId>';"
sqlite3 smithers.db "SELECT verdict, blocking, total_findings FROM synthesis_verdict WHERE run_id='<runId>';"
sqlite3 smithers.db "SELECT * FROM posted_review WHERE run_id='<runId>';"   # empty before approval

# Stage 2 — approve and resume (GREEN path)
bunx --bun smithers-orchestrator approve <runId> --node review-gate --by lead-reviewer
bunx --bun smithers-orchestrator up workflow.tsx --resume --run-id <runId> --format json
# exit 0; only review-gate and post-review appear in the log

# Verify
sqlite3 smithers.db "SELECT posted, verdict, approved_by, headline FROM posted_review WHERE run_id='<runId>';"

# Deny path (run separately to test the other branch)
bunx --bun smithers-orchestrator up workflow.tsx --format json          # new run, pauses
bunx --bun smithers-orchestrator deny <runId2> --node review-gate --by lead-reviewer
bunx --bun smithers-orchestrator up workflow.tsx --resume --run-id <runId2> --format json
sqlite3 smithers.db "SELECT posted, headline FROM posted_review WHERE run_id='<runId2>';"
# posted=0, headline "Review WITHHELD: ..."
```

## Expected output

**First `up` (gate pause):**
```
[00:00:00] -> review-correctness (attempt 1, iteration 0)
[00:00:00] -> review-security (attempt 1, iteration 0)
[00:00:00] -> review-style (attempt 1, iteration 0)
[00:00:11] ✔ review-security (attempt 1)
[00:00:11] ✔ review-correctness (attempt 1)
[00:00:12] ✔ review-style (attempt 1)
[00:00:12] -> synthesize (attempt 1, iteration 0)
[00:00:45] ✔ synthesize (attempt 1)
{"runId":"<runId>","status":"waiting-approval",...}
exit=3
```

**Resume after approve (verified output, runId `ba929670`):**
```
[00:00:00] -> review-gate (attempt 1, iteration 0)
[00:00:00] ✔ review-gate (attempt 1)
[00:00:00] -> post-review (attempt 1, iteration 0)
[00:00:00] ✔ post-review (attempt 1)
[00:00:00] ✔ Run finished
{"runId":"ba929670-ec0d-40d9-9b21-d35294b2febe","status":"finished"}
exit=0
```

**`posted_review` row (approve path):**
```
posted=1 | verdict=request-changes | approved_by=lead-reviewer
headline=Review POSTED: request-changes (15 findings)
```

**`posted_review` row (deny path, runId `90da1cbb`):**
```
posted=0 | verdict=request-changes | approved_by=lead-reviewer
headline=Review WITHHELD: request-changes (10 findings)
```

## What it proves

Verified live on smithers-orchestrator@0.24.2:

- **Approve path** (runId `ba929670-ec0d-40d9-9b21-d35294b2febe`): all four agent tasks finished in one attempt each; the run paused at the gate (exit 3); after `approve`, resume completed in under a second with only `review-gate` and `post-review` executing; `posted_review` recorded `posted=1` with the judge's verdict and the human approver's identity.
- **Deny path** (runId `90da1cbb-7b43-4226-bb2a-de7939820de4`): same pause/resume pattern; `posted_review` recorded `posted=0` and headline "Review WITHHELD"; the workflow finished cleanly (exit 0) — every outcome is audited.
- **Durability**: `_smithers_attempts` shows exactly `attempt=1, state=finished` for all six nodes across both runs. No task was replayed on resume.
- **Specialist focus**: the correctness agent caught the planted wrong-return bug and the missing negative-pct guard; the security agent caught SQL injection and credential logging; the style agent caught `var`, missing semicolons, and line-length violations — each staying within its declared domain.

## How it works

The workflow in `workflow.tsx` has four stages wired as a `<Sequence>`:

1. **`<Parallel maxConcurrency={3}>`** — fires `review-correctness`, `review-security`, and `review-style` simultaneously. Each is a `<Task>` backed by a separate `AnthropicAgent` with a distinct specialist system prompt. Outputs are persisted to typed SQLite tables via Zod schemas.

2. **`synthesize` task** — a judge `AnthropicAgent` reads the three reviewer outputs with `ctx.outputMaybe` and produces a single `synthesisVerdict` with a deduplicated, severity-ranked `prioritizedFindings` array and a `verdict` / `blocking` flag.

3. **`<Approval id="review-gate">`** — pauses the run. The gate `request.summary` is built from the live judge output (`synth?.totalFindings`, `synth?.verdict`), so the human sees a meaningful prompt. The run exits code 3; no process stays alive. The `smithers approve` / `smithers deny` CLI writes to `_smithers_approvals` in the same SQLite database.

4. **Conditional `post-review` task** — rendered only when `decision` (the gate output) is non-null: `{decision ? <Task .../> : null}`. It records `posted`, `verdict`, `approvedBy`, `postedAt`, and `headline` regardless of whether the gate was approved or denied, giving a complete audit trail either way.

## Key gotchas

**Exit code 3 is not a failure.** When the run pauses at an `Approval` gate, `smithers up` exits with code 3 and prints `status: "waiting-approval"`. Scripts that treat any non-zero exit as an error will mishandle this. Check the JSON status field, not just `$?`.

**Resume skips every finished task silently.** On resume, the log only shows `review-gate` and `post-review` — the four LLM tasks are absent. Smithers looks up each node's output in SQLite and skips it if already finished. A resume that completes in under a second is correct, not truncated.

**`onDeny="skip"` still runs downstream conditional tasks.** With `onDeny="skip"`, a denial resolves `gateDecision` with `approved=false` (not null), so the `{decision ? <Task/> : null}` condition is true and `post-review` executes. This is intentional for audit-trail systems: the denial is recorded, not ignored.

**`totalFindings` is the judge's self-reported estimate.** The `synthesisVerdict.totalFindings` field is stored as `z.string()` (not a number) to avoid integer truncation. Its value is the judge LLM's own count of findings after synthesis, which may differ from the raw count across the three reviewer tables. Treat it as an estimate from the model, not a verified tally.

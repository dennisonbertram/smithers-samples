# Multi-agent code review with a human approval gate

> Three specialist AI reviewers fan out in parallel, a judge synthesizes their findings, and a human must approve before any review is posted — all in one durable, resumable workflow.

## TL;DR

You feed this workflow a code diff and it dispatches three AI reviewers at the same time — one looking for bugs, one checking for security problems, one reviewing style — then a fourth AI reads all three reports and writes a single consolidated verdict. The whole run then pauses and waits for a real human to say "post it" or "hold it" before anything is published, with a record of who decided and when saved to a local database file regardless of outcome. This solves the problem of AI-generated code reviews going out unchecked: you get the speed of parallel AI analysis with a mandatory human sign-off before the feedback ever reaches a developer.

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

**Resume after approve:**
```
[00:00:00] -> review-gate (attempt 1, iteration 0)
[00:00:00] ✔ review-gate (attempt 1)
[00:00:00] -> post-review (attempt 1, iteration 0)
[00:00:00] ✔ post-review (attempt 1)
[00:00:00] ✔ Run finished
{"runId":"<runId>","status":"finished"}
exit=0
```

**`posted_review` row (approve path):**
```
posted=1 | verdict=request-changes | approved_by=lead-reviewer
headline=Review POSTED: request-changes (15 findings)
```

**`posted_review` row (deny path):**
```
posted=0 | verdict=request-changes | approved_by=lead-reviewer
headline=Review WITHHELD: request-changes (10 findings)
```

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

## What you'll learn & how to apply it

**What you'll learn**

This sample teaches the parallel-fan-out + synthesis + HITL gate pattern: how to run independent AI specialists concurrently, merge their structured outputs through a judge agent, and insert a mandatory human decision point before any side effect executes — all with Smithers' built-in durability so the LLM work is never replayed on resume.

**How to apply it to your own project**

- **Real PR review bot.** Replace the hardcoded diff string with a live diff fetched from the GitHub API (a pull_request webhook → `octokit.pulls.get`). Add a `license-compliance` reviewer agent alongside the existing three. After the approval gate, post the judge's verdict as a GitHub PR review comment via `octokit.pulls.createReview` instead of writing to SQLite.
- **Security-gated CI step.** Feed the workflow a SAST tool's JSON output (e.g., Semgrep results) as the "diff". Replace the style reviewer with a "false-positive filter" agent. Wire the approval gate to a Slack message so the on-call engineer approves or denies from their phone before the pipeline proceeds to deploy.
- **Multi-reviewer document or prompt approval.** Swap the code diff for a draft prompt, policy document, or marketing copy. Point each specialist at a different concern (factual accuracy, tone, compliance). The gate then requires a human content lead to sign off before the copy is published or the prompt is promoted to production.
- **Auditable AI action in any domain.** The core pattern — parallel agents → judge → HITL gate → conditional side effect with an audit row written regardless of outcome — applies to any workflow where an AI recommendation must be human-authorized before it causes a real-world change (sending an email, merging a branch, updating a database record).

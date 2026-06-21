/** @jsxImportSource smithers-orchestrator */
import {
  createSmithers,
  Sequence,
  Parallel,
  Task,
  Approval,
  approvalDecisionSchema,
  AnthropicAgent,
} from "smithers-orchestrator";
import { z } from "zod";

// ──────────────────────────────────────────────────────────────
// Buggy sample diff — three planted defects for the reviewers
// ──────────────────────────────────────────────────────────────

const DIFF = `--- a/discount.js
+++ b/discount.js
@@ -1,22 +1,30 @@
-// Applies a percentage discount to a price
-function applyDiscount(price, pct) {
-  if (pct > 100) throw new Error("invalid");
-  const discount = price * (pct / 100);
-  return price - discount;
-}
+// BUG A (correctness): returns discount amount, not discounted price; also no guard for pct<0
+var applyDiscount = function(price, pct) {         // BUG C (style): var, no JSDoc, 140-char lines
+  if (pct > 100) throw new Error("invalid pct");  // missing guard: pct < 0 not checked
+  const discount = price * (pct / 100)             // BUG C: missing semicolon
+  return discount                                  // BUG A: should return price - discount, not discount
+}
+
+// BUG B (security): SQL injection via template literal + credential logging
+var getUserDiscount = async function(userId, req) {
+  const query = \`SELECT * FROM users WHERE id = \${userId}\` // BUG B: SQL injection
+  console.log("Authorization token", req.headers.authorization) // BUG B: logs credential
+  const result = await db.query(query)
+  return result.rows[0]?.discount_pct ?? 0                                                          // very long line exceeding 140 chars for style check — padding to make sure the linter catches this for the style reviewer
+}
`;

// ──────────────────────────────────────────────────────────────
// Schema definitions
// ──────────────────────────────────────────────────────────────

const findingSchema = z.object({
  id: z.string(),
  title: z.string(),
  severity: z.string(), // "critical"|"high"|"medium"|"low"|"none"
  line: z.string(),
  detail: z.string(),
  suggestedFix: z.string(),
});

const reviewSchema = z.object({
  reviewer: z.string(),
  summary: z.string(),
  findings: z.array(findingSchema),
  recommendation: z.string(), // "approve"|"request-changes"
});

const { Workflow, smithers, outputs } = createSmithers({
  correctnessReview: reviewSchema,
  securityReview: reviewSchema,
  styleReview: reviewSchema,
  synthesisVerdict: z.object({
    verdict: z.string(), // "approve"|"request-changes"
    blocking: z.boolean(),
    prioritizedFindings: z.array(
      z.object({
        rank: z.string(),
        source: z.string(), // correctness|security|style
        title: z.string(),
        severity: z.string(),
        line: z.string(),
        rationale: z.string(),
      })
    ),
    summary: z.string(),
    totalFindings: z.string(), // string to avoid INTEGER truncation
  }),
  gateDecision: approvalDecisionSchema,
  postedReview: z.object({
    posted: z.boolean(),
    verdict: z.string(),
    approvedBy: z.string(),
    postedAt: z.string(),
    findingCount: z.string(),
    headline: z.string(),
  }),
});

// ──────────────────────────────────────────────────────────────
// Specialist reviewer agents (all claude-haiku-4-5)
// ──────────────────────────────────────────────────────────────

const ANTI_FENCE =
  "Return ONLY a raw JSON object matching the schema. No markdown, no code fences. Start with { end with }.";

const correctnessAgent = new AnthropicAgent({
  model: "claude-haiku-4-5",
  maxOutputTokens: 1024,
  instructions: `You are a senior engineer reviewing ONLY for correctness/logic bugs (wrong returns, off-by-one, bad operators, null/undefined, error handling). Ignore security and style. For each issue emit a finding with severity critical/high/medium/low. Set recommendation to request-changes if any high+ finding, else approve. ${ANTI_FENCE}`,
});

const securityAgent = new AnthropicAgent({
  model: "claude-haiku-4-5",
  maxOutputTokens: 1024,
  instructions: `You are an application security reviewer. Review ONLY for security issues (injection, secret/credential leakage, unsafe logging, missing validation, authz). Ignore pure style and non-security logic bugs. Set recommendation to request-changes if any high+ finding, else approve. ${ANTI_FENCE}`,
});

const styleAgent = new AnthropicAgent({
  model: "claude-haiku-4-5",
  maxOutputTokens: 1024,
  instructions: `You are a style/readability reviewer. Review ONLY for style/idiom issues (var vs const, missing semicolons, line length, naming, missing docs). These are usually low/medium severity; never critical. Set recommendation to approve unless there are many medium issues. ${ANTI_FENCE}`,
});

const judgeAgent = new AnthropicAgent({
  model: "claude-haiku-4-5",
  maxOutputTokens: 1024,
  instructions: `You are the lead reviewer synthesizing three specialist reviews into ONE verdict. Deduplicate overlapping findings, rank by severity (critical>high>medium>low), set verdict=request-changes if ANY finding is high or critical (set blocking=true), else approve (blocking=false). Output prioritizedFindings ranked '1','2',.... Do NOT re-review the code yourself; synthesize ONLY the provided findings. ${ANTI_FENCE}`,
});

// ──────────────────────────────────────────────────────────────
// Prompt helpers
// ──────────────────────────────────────────────────────────────

function reviewPrompt(kind: string, diff: string): string {
  return `Review this unified diff as the ${kind} reviewer. Diff:\n\`\`\`diff\n${diff}\n\`\`\`\nReturn JSON only.`;
}

function synthesisPrompt(
  c: { findings: unknown[]; recommendation: string } | null | undefined,
  s: { findings: unknown[]; recommendation: string } | null | undefined,
  st: { findings: unknown[]; recommendation: string } | null | undefined
): string {
  return `Synthesize these three specialist code reviews into one verdict. Return JSON only.

Correctness reviewer findings: ${JSON.stringify(c?.findings ?? [])}
Correctness recommendation: ${c?.recommendation ?? "pending"}

Security reviewer findings: ${JSON.stringify(s?.findings ?? [])}
Security recommendation: ${s?.recommendation ?? "pending"}

Style reviewer findings: ${JSON.stringify(st?.findings ?? [])}
Style recommendation: ${st?.recommendation ?? "pending"}

Synthesize into one verdict. Return JSON only.`;
}

// ──────────────────────────────────────────────────────────────
// Workflow
// ──────────────────────────────────────────────────────────────

export default smithers((ctx) => {
  const diff = (ctx.input as { diff?: string }).diff ?? DIFF;

  // Read upstream outputs for downstream tasks
  const c = ctx.outputMaybe(outputs.correctnessReview, {
    nodeId: "review-correctness",
  });
  const s = ctx.outputMaybe(outputs.securityReview, {
    nodeId: "review-security",
  });
  const st = ctx.outputMaybe(outputs.styleReview, { nodeId: "review-style" });
  const synth = ctx.outputMaybe(outputs.synthesisVerdict, {
    nodeId: "synthesize",
  });
  const decision = ctx.outputMaybe(outputs.gateDecision, {
    nodeId: "review-gate",
  });

  return (
    <Workflow name="multi-agent-code-review-hitl">
      <Sequence>
        {/* STAGE 1: Parallel fan-out — 3 specialist reviewers */}
        <Parallel maxConcurrency={3}>
          <Task
            id="review-correctness"
            agent={correctnessAgent}
            output={outputs.correctnessReview}
            retries={2}
          >
            {reviewPrompt("correctness", diff)}
          </Task>
          <Task
            id="review-security"
            agent={securityAgent}
            output={outputs.securityReview}
            retries={2}
          >
            {reviewPrompt("security", diff)}
          </Task>
          <Task
            id="review-style"
            agent={styleAgent}
            output={outputs.styleReview}
            retries={2}
          >
            {reviewPrompt("style", diff)}
          </Task>
        </Parallel>

        {/* STAGE 2: Judge synthesizes all three reviews */}
        <Task
          id="synthesize"
          agent={judgeAgent}
          output={outputs.synthesisVerdict}
          retries={2}
        >
          {synthesisPrompt(c, s, st)}
        </Task>

        {/* STAGE 3: Human approval gate — pauses run (exit code 3) */}
        <Approval
          id="review-gate"
          output={outputs.gateDecision}
          request={{
            title: `Post code review: ${synth?.verdict ?? "pending"}`,
            summary: `${synth?.totalFindings ?? "?"} findings; verdict=${synth?.verdict ?? "pending"}. Approve to post the review to the PR.`,
          }}
          onDeny="skip"
        />

        {/* STAGE 4: Post the review — only if gate approved */}
        {decision ? (
          <Task id="post-review" output={outputs.postedReview}>
            {{
              posted: decision.approved,
              verdict: synth?.verdict ?? "unknown",
              approvedBy: decision.decidedBy ?? "unknown",
              postedAt: new Date().toISOString(),
              findingCount: synth?.totalFindings ?? "0",
              headline: `Review ${decision.approved ? "POSTED" : "WITHHELD"}: ${synth?.verdict ?? "unknown"} (${synth?.totalFindings ?? "0"} findings)`,
            }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});

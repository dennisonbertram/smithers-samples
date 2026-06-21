/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence, Parallel, Task, Branch } from "smithers-orchestrator";
import { AnthropicAgent } from "smithers-orchestrator";
import { llmJudge } from "smithers-orchestrator/scorers";
import { z } from "zod";
import { Database } from "bun:sqlite";

// ──────────────────────────────────────────────────────────────
// Pricing constants — live from Anthropic pricing doc (2026-06-21)
// Input/Output in $/1M tokens
// ──────────────────────────────────────────────────────────────
const PRICE = {
  haiku:  { in: 1.00,  out: 5.00  }, // claude-haiku-4-5
  sonnet: { in: 3.00,  out: 15.00 }, // claude-sonnet-4-6
  opus:   { in: 5.00,  out: 25.00 }, // claude-opus-4-8
};

// ──────────────────────────────────────────────────────────────
// Schema definitions — z.string() for ALL numeric/fractional fields
// ──────────────────────────────────────────────────────────────

const { Workflow, smithers, outputs } = createSmithers({
  classification: z.object({
    itemId:       z.string(),
    tier:         z.enum(["trivial", "moderate", "hard"]),
    routedModel:  z.enum(["haiku", "sonnet", "opus"]),
    reason:       z.string(),
  }),
  solveResult: z.object({
    itemId:  z.string(),
    tier:    z.enum(["haiku", "sonnet", "opus"]),
    answer:  z.string(),
    taskId:  z.string(),
  }),
  verifyResult: z.object({
    itemId:      z.string(),
    tier:        z.string(),
    qualityPass: z.boolean(),
    score:       z.string(),
    reason:      z.string(),
  }),
  escalation: z.object({
    itemId:    z.string(),
    fromTier:  z.string(),
    toTier:    z.string(),
    reason:    z.string(),
  }),
  costLedger: z.object({
    totalInputTokens:  z.string(),
    totalOutputTokens: z.string(),
    totalCostUsd:      z.string(),
    perTier:           z.string(),
    escalations:       z.string(),
    itemsBelowBar:     z.string(),
  }),
});

// ──────────────────────────────────────────────────────────────
// Agents
// ──────────────────────────────────────────────────────────────

const classifier = new AnthropicAgent({
  model: "claude-haiku-4-5",
  instructions: `You are a task router. Classify difficulty as trivial|moderate|hard.
trivial=single-step lookup or arithmetic; moderate=short summarization/rewriting; hard=multi-step reasoning or non-trivial code.
Map trivial->haiku, moderate->sonnet, hard->opus.
Return ONLY raw JSON: {"itemId":"<id>","tier":"<tier>","routedModel":"<model>","reason":"<reason>"}. No markdown. No code fences.`,
});

const solverHaiku = new AnthropicAgent({
  model: "claude-haiku-4-5",
  instructions: `You are a concise, correct solver. Answer the question.
Return ONLY raw JSON: {"itemId":"<echo itemId>","tier":"haiku","answer":"<your answer>","taskId":"<echo taskId>"}.
No markdown. No code fences. Echo itemId and taskId EXACTLY as given in the prompt.`,
});

const solverSonnet = new AnthropicAgent({
  model: "claude-sonnet-4-6",
  instructions: `You are a concise, correct solver. Answer the question.
Return ONLY raw JSON: {"itemId":"<echo itemId>","tier":"sonnet","answer":"<your answer>","taskId":"<echo taskId>"}.
No markdown. No code fences. Echo itemId and taskId EXACTLY as given in the prompt.`,
});

const solverOpus = new AnthropicAgent({
  model: "claude-opus-4-8",
  instructions: `You are a concise, correct solver. Answer the question.
Return ONLY raw JSON: {"itemId":"<echo itemId>","tier":"opus","answer":"<your answer>","taskId":"<echo taskId>"}.
No markdown. No code fences. Echo itemId and taskId EXACTLY as given in the prompt.`,
});

const verifier = new AnthropicAgent({
  model: "claude-sonnet-4-6",
  instructions: `You are a strict answer-quality grader. Your job: check if the CANDIDATE ANSWER is correct.

For MATH/ARITHMETIC: Compute the answer yourself. If candidate matches (within $0.01 for money, exact for integers): qualityPass=true, score="1.00". If not: qualityPass=false, score="0.10".
For SUMMARIES: If all main facts present and accurate: qualityPass=true, score="0.95". If key facts wrong/missing: qualityPass=false, score="0.20".
For CODE: Mentally trace through the code for the given test cases. If ALL test cases would pass AND the function signature is exactly correct: qualityPass=true, score="1.00". If ANY test case fails OR signature is wrong: qualityPass=false, score="0.10". Be rigorous - trace each test case.

Return ONLY raw JSON:
{"itemId":"<echo itemId>","tier":"<echo tier>","qualityPass":<true or false>,"score":"<score>","reason":"<brief conclusion>"}
No markdown. No explanation outside the JSON.`,
});

// Judge agent for llmJudge scorer (supplemental observability, not gating)
const judgeAgent = new AnthropicAgent({
  model: "claude-haiku-4-5",
  instructions: `You are an answer quality judge. Given a question and answer, score correctness 0.0-1.0.
Return ONLY raw JSON: {"score":<0.0-1.0>,"reason":"<brief reason>"}. No markdown. No code fences.`,
});

const solveJudge = llmJudge({
  id:          "solve-quality",
  name:        "Solve Quality Judge",
  description: "Scores solver answer quality 0-1",
  judge:       judgeAgent,
  instructions: "Score this answer on correctness and completeness (0.0-1.0). Return JSON {score, reason}.",
  promptTemplate: (input) =>
    `Question/Task: ${JSON.stringify(input.input)}\nCandidate Answer: ${JSON.stringify(input.output)}`,
});

// ──────────────────────────────────────────────────────────────
// Work items (default batch)
// ──────────────────────────────────────────────────────────────

const DEFAULT_ITEMS = [
  {
    itemId: "easy-arith",
    question: "What is 17 + 26? Reply with the integer only.",
  },
  {
    itemId: "summary",
    question: `Summarize the following paragraph in one concise sentence:
"The Amazon rainforest, often described as the lungs of the Earth, produces roughly 20% of the world's oxygen through photosynthesis. It spans over 5.5 million square kilometres across nine countries, with Brazil hosting approximately 60% of the total area. Beyond oxygen production, the forest is home to an estimated 10% of all species on Earth and plays a critical role in regulating the global water cycle."`,
  },
  {
    itemId: "hard-reasoning",
    question: `A snail is at the bottom of a 10-metre well. Each day it climbs 3 metres, but each night it slides back 2 metres. How many days does it take for the snail to reach the top of the well? Show your reasoning day by day and give the final answer as an integer number of days.`,
  },
];

// ──────────────────────────────────────────────────────────────
// Build the per-item pipeline
// ──────────────────────────────────────────────────────────────

function buildItemPipeline(
  ctx: Parameters<Parameters<typeof smithers>[0]>[0],
  item: { itemId: string; question: string },
  qualityBar: number,
  key?: string,
) {
  const { itemId, question } = item;

  // Read upstream outputs for this item
  const classification = ctx.outputMaybe(outputs.classification, { nodeId: `classify-${itemId}` });
  const haikuSolve     = ctx.outputMaybe(outputs.solveResult,    { nodeId: `solve-haiku-${itemId}` });
  const haikuVerify    = ctx.outputMaybe(outputs.verifyResult,   { nodeId: `verify-haiku-${itemId}` });

  // Escalation branch conditions: pass if qualityPass=true AND score >= qualityBar
  const verifyScore = Number(haikuVerify?.score ?? "0");
  const cheapPass = haikuVerify?.qualityPass === true && verifyScore >= qualityBar;
  const ceiling = classification?.tier ?? "moderate";

  return (
    <Sequence key={key}>
      {/* Stage 1: Classify */}
      <Task
        id={`classify-${itemId}`}
        agent={classifier}
        output={outputs.classification}
        retries={1}
      >
        {`Classify this task. itemId="${itemId}". Task: ${question}`}
      </Task>

      {/* Stage 2: Solve at haiku (cost-first policy — always attempt cheap first) */}
      <Task
        id={`solve-haiku-${itemId}`}
        agent={solverHaiku}
        output={outputs.solveResult}
        retries={1}
        scorers={{ judge: { scorer: solveJudge } }}
      >
        {`itemId="${itemId}" taskId="solve-haiku-${itemId}" tier="haiku"\nQuestion: ${question}`}
      </Task>

      {/* Stage 3: Verify haiku answer */}
      <Task
        id={`verify-haiku-${itemId}`}
        agent={verifier}
        output={outputs.verifyResult}
        retries={1}
      >
        {`itemId="${itemId}" tier="haiku"\nQUESTION: ${question}\nCANDIDATE ANSWER: ${haikuSolve?.answer ?? "(no answer yet)"}`}
      </Task>

      {/* Stage 4: Escalation branch — skip if cheap passed */}
      <Branch
        if={cheapPass}
        then={null}
        else={
          <Branch
            if={ceiling === "hard"}
            then={
              <Sequence>
                <Task
                  id={`record-escalation-${itemId}`}
                  output={outputs.escalation}
                >
                  {{
                    itemId,
                    fromTier: "haiku",
                    toTier: "opus",
                    reason: haikuVerify?.reason ?? "cheap tier failed quality bar",
                  }}
                </Task>
                <Task
                  id={`solve-opus-${itemId}`}
                  agent={solverOpus}
                  output={outputs.solveResult}
                  retries={1}
                  scorers={{ judge: { scorer: solveJudge } }}
                >
                  {`itemId="${itemId}" taskId="solve-opus-${itemId}" tier="opus"\nQuestion: ${question}`}
                </Task>
                <Task
                  id={`verify-opus-${itemId}`}
                  agent={verifier}
                  output={outputs.verifyResult}
                  retries={1}
                >
                  {(() => {
                    const opusSolve = ctx.outputMaybe(outputs.solveResult, { nodeId: `solve-opus-${itemId}` });
                    return `itemId="${itemId}" tier="opus"\nQUESTION: ${question}\nCANDIDATE ANSWER: ${opusSolve?.answer ?? "(no answer yet)"}`;
                  })()}
                </Task>
              </Sequence>
            }
            else={
              <Sequence>
                <Task
                  id={`record-escalation-${itemId}`}
                  output={outputs.escalation}
                >
                  {{
                    itemId,
                    fromTier: "haiku",
                    toTier: "sonnet",
                    reason: haikuVerify?.reason ?? "cheap tier failed quality bar",
                  }}
                </Task>
                <Task
                  id={`solve-sonnet-${itemId}`}
                  agent={solverSonnet}
                  output={outputs.solveResult}
                  retries={1}
                  scorers={{ judge: { scorer: solveJudge } }}
                >
                  {`itemId="${itemId}" taskId="solve-sonnet-${itemId}" tier="sonnet"\nQuestion: ${question}`}
                </Task>
                <Task
                  id={`verify-sonnet-${itemId}`}
                  agent={verifier}
                  output={outputs.verifyResult}
                  retries={1}
                >
                  {(() => {
                    const sonnetSolve = ctx.outputMaybe(outputs.solveResult, { nodeId: `solve-sonnet-${itemId}` });
                    return `itemId="${itemId}" tier="sonnet"\nQUESTION: ${question}\nCANDIDATE ANSWER: ${sonnetSolve?.answer ?? "(no answer yet)"}`;
                  })()}
                </Task>
              </Sequence>
            }
          />
        }
      />
    </Sequence>
  );
}

// ──────────────────────────────────────────────────────────────
// Main workflow
// ──────────────────────────────────────────────────────────────

export default smithers((ctx) => {
  const qualityBar = Number(ctx.input.qualityBar ?? "0.96");
  const items = DEFAULT_ITEMS;

  return (
    <Workflow name="cost-aware-model-router">
      <Sequence>
        {/* STAGE A: Per-item pipelines — run in parallel */}
        <Parallel maxConcurrency={3}>
          {items.map((item) => buildItemPipeline(ctx, item, qualityBar, item.itemId))}
        </Parallel>

        {/* STAGE B: Cost attribution — runs AFTER all agent tasks complete */}
        <Task id="cost-attribution" output={outputs.costLedger}>
          {async () => {
            const dbPath = process.env.SMITHERS_DB_PATH ?? "./smithers.db";
            const db = new Database(dbPath, { readonly: true });

            // Query token usage events for this run
            const rows = db
              .query<{ payload_json: string }, [string]>(
                "SELECT payload_json FROM _smithers_events WHERE run_id = ? AND type = 'TokenUsageReported'"
              )
              .all(ctx.runId);

            // Attribute cost by nodeId prefix (model field = 'unknown' on 0.24.2)
            type TierKey = "haiku" | "sonnet" | "opus";
            const tierMap: Record<TierKey, { inputTokens: number; outputTokens: number; calls: number }> = {
              haiku:  { inputTokens: 0, outputTokens: 0, calls: 0 },
              sonnet: { inputTokens: 0, outputTokens: 0, calls: 0 },
              opus:   { inputTokens: 0, outputTokens: 0, calls: 0 },
            };

            function getTier(nodeId: string): TierKey {
              if (nodeId.startsWith("solve-opus"))   return "opus";
              if (nodeId.startsWith("solve-sonnet")) return "sonnet";
              if (nodeId.startsWith("solve-haiku"))  return "haiku";
              if (nodeId.startsWith("classify"))     return "haiku";
              if (nodeId.startsWith("verify"))       return "sonnet";
              if (nodeId.startsWith("record-escalation")) return "haiku";
              return "haiku";
            }

            let totalInput = 0;
            let totalOutput = 0;

            for (const row of rows) {
              const payload = JSON.parse(row.payload_json) as {
                nodeId: string;
                inputTokens: number;
                outputTokens: number;
              };
              const tier = getTier(payload.nodeId);
              tierMap[tier].inputTokens  += payload.inputTokens;
              tierMap[tier].outputTokens += payload.outputTokens;
              tierMap[tier].calls        += 1;
              totalInput  += payload.inputTokens;
              totalOutput += payload.outputTokens;
            }

            // Calculate costs
            let totalCost = 0;
            const perTierArr: Array<{ tier: string; inputTokens: number; outputTokens: number; costUsd: string; calls: number }> = [];

            for (const [tier, stats] of Object.entries(tierMap) as [TierKey, typeof tierMap[TierKey]][]) {
              const price = PRICE[tier];
              const costUsd = stats.inputTokens / 1e6 * price.in + stats.outputTokens / 1e6 * price.out;
              totalCost += costUsd;
              perTierArr.push({
                tier,
                inputTokens:  stats.inputTokens,
                outputTokens: stats.outputTokens,
                costUsd:      costUsd.toFixed(6),
                calls:        stats.calls,
              });
            }

            // Count escalations from DB
            const escalationCount = db
              .query<{ c: number }, [string]>(
                "SELECT count(*) as c FROM escalation WHERE run_id = ?"
              )
              .get(ctx.runId)?.c ?? 0;

            // Count items below bar at haiku tier (qualityPass = 0 at haiku solve)
            const belowBar = db
              .query<{ c: number }, [string]>(
                "SELECT count(*) as c FROM verify_result WHERE run_id = ? AND tier = 'haiku' AND quality_pass = 0"
              )
              .get(ctx.runId)?.c ?? 0;

            db.close();

            return {
              totalInputTokens:  String(totalInput),
              totalOutputTokens: String(totalOutput),
              totalCostUsd:      totalCost.toFixed(6),
              perTier:           JSON.stringify(perTierArr),
              escalations:       String(escalationCount),
              itemsBelowBar:     String(belowBar),
            };
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});

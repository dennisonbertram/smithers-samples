/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence, Loop, Task } from "smithers-orchestrator";
import { AnthropicAgent } from "smithers-orchestrator";
import { llmJudge } from "smithers-orchestrator/scorers";
import { z } from "zod";

// ──────────────────────────────────────────────────────────────
// Schema definitions
// ──────────────────────────────────────────────────────────────

const { Workflow, smithers, outputs } = createSmithers({
  draft: z.object({
    revNum: z.string().describe("which revision this is, e.g. '1'"),
    title: z.string(),
    body: z.string().describe("full content, markdown"),
    wordCount: z.string().describe("string to avoid SQLite INTEGER truncation"),
    changeNote: z
      .string()
      .describe("what changed vs the prior draft, or 'initial draft'"),
  }),
  critique: z.object({
    score: z
      .string()
      .describe(
        "0-100 overall quality as a STRING — z.number() truncates and we want exact value preserved as written"
      ),
    passed: z
      .boolean()
      .describe("true when score >= threshold"),
    coverage: z.string(),
    toneFit: z.string(),
    concision: z.string(),
    feedback: z
      .string()
      .describe("specific, actionable revision instructions"),
    missingPoints: z.array(z.string()),
  }),
});

// ──────────────────────────────────────────────────────────────
// Agents
// ──────────────────────────────────────────────────────────────

const writer = new AnthropicAgent({
  model: "claude-haiku-4-5",
  maxOutputTokens: 1500,
  instructions:
    "You are a senior content writer. Given a brief and (optionally) a prior draft plus an editor's critique, produce the best possible piece. If a critique is provided, address EVERY point in it. Return ONLY raw JSON matching the schema (no code fences). Keep body under the brief's maxWords.",
});

const judge = new AnthropicAgent({
  model: "claude-haiku-4-5",
  maxOutputTokens: 800,
  instructions:
    "You are a STRICT senior content editor scoring against the brief on a 0-100 scale. Be harsh on the first pass. Deduct for: missing required points, wrong audience/tone, exceeding maxWords, vague claims. Return ONLY raw JSON. 'score' is your integer 0-100 as a string. 'passed' must be true iff score >= the threshold stated in the prompt. 'feedback' must be concrete revision instructions; 'missingPoints' lists required brief points not yet covered.",
});

// Scorer judge — separate agent for the llmJudge side-channel
const scorerJudgeAgent = new AnthropicAgent({
  model: "claude-haiku-4-5",
  maxOutputTokens: 300,
  instructions:
    "You are a content quality scorer. Rate text 0-1 for overall editorial quality. Return JSON {\"score\":<0.0-1.0>,\"reason\":\"...\"}. Return ONLY raw JSON, no markdown.",
});

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

type Brief = {
  topic: string;
  audience: string;
  requiredPoints: string[];
  tone: string;
  maxWords: number;
};

type DraftOutput = {
  revNum: string;
  title: string;
  body: string;
  wordCount: string;
  changeNote: string;
};

type CritiqueOutput = {
  score: string;
  passed: boolean;
  coverage: string;
  toneFit: string;
  concision: string;
  feedback: string;
  missingPoints: string[];
};

// ──────────────────────────────────────────────────────────────
// Prompt builders
// ──────────────────────────────────────────────────────────────

function writerPrompt(
  brief: Brief,
  latestDraft: DraftOutput | undefined,
  latestCritique: CritiqueOutput | undefined,
  threshold: number
): string {
  const briefText = `CONTENT BRIEF:
Topic: ${brief.topic}
Audience: ${brief.audience}
Required points to cover: ${brief.requiredPoints.join(", ")}
Tone: ${brief.tone}
Max words: ${brief.maxWords}`;

  if (!latestCritique || !latestDraft) {
    return `${briefText}

Write the initial draft. Return ONLY raw JSON with fields: revNum (string, "1"), title (string), body (string, markdown), wordCount (string), changeNote (string "initial draft").`;
  }

  return `${briefText}

PRIOR DRAFT (revision ${latestDraft.revNum}):
Title: ${latestDraft.title}
Body: ${latestDraft.body}

EDITOR'S CRITIQUE (score was ${latestCritique.score}/100 — must reach ${threshold} to pass):
${latestCritique.feedback}

MISSING POINTS that must be added:
${latestCritique.missingPoints.length > 0 ? latestCritique.missingPoints.map((p) => `- ${p}`).join("\n") : "None listed — but review all required points from the brief"}

REVISION INSTRUCTIONS: Address EVERY critique point above. Ensure ALL required points from the brief are explicitly covered. Keep body under ${brief.maxWords} words.

Return ONLY raw JSON with fields: revNum (string, the next number), title (string), body (string, markdown), wordCount (string), changeNote (string describing what you fixed).`;
}

function judgePrompt(
  brief: Brief,
  threshold: number,
  latestDraft: DraftOutput | undefined
): string {
  if (!latestDraft) {
    return `No draft available yet. Return a JSON critique with score "0", passed false, and feedback "No draft to evaluate."`;
  }

  return `CONTENT BRIEF:
Topic: ${brief.topic}
Audience: ${brief.audience}
Required points that MUST be covered: ${brief.requiredPoints.join(", ")}
Tone: ${brief.tone}
Max words: ${brief.maxWords}

DRAFT TO EVALUATE (revision ${latestDraft.revNum}):
Title: ${latestDraft.title}
Body: ${latestDraft.body}

SCORING THRESHOLD: ${threshold}/100. Set 'passed' to true ONLY if score >= ${threshold}.

SCORING RUBRIC:
- Coverage: Does the draft address EACH required point? Deduct 10 pts per missing point.
- Audience fit: Is the tone/language right for "${brief.audience}"? Deduct up to 20 pts.
- Tone: Does it match "${brief.tone}"? Deduct up to 15 pts for mismatch.
- Concision: Is it within ${brief.maxWords} words? Deduct 15 pts if over.
- Factual consistency: Any contradictions or vague claims? Deduct up to 15 pts.

Be STRICT on iteration 1 — it is the initial draft and is unlikely to be perfect.

Return ONLY raw JSON with fields: score (string integer 0-100), passed (boolean true iff score >= ${threshold}), coverage (string), toneFit (string), concision (string), feedback (string with specific revision instructions), missingPoints (array of strings — required brief points not yet covered in the draft).`;
}

// ──────────────────────────────────────────────────────────────
// Workflow
// ──────────────────────────────────────────────────────────────

const DEFAULT_BRIEF: Brief = {
  topic: "Why small businesses should adopt AI-powered customer service chatbots",
  audience: "Small business owners with no technical background",
  requiredPoints: [
    "cost savings compared to hiring additional staff",
    "24/7 availability benefits",
    "specific ROI statistics or case study",
    "common objections and how to overcome them",
    "step-by-step getting started guide",
  ],
  tone: "practical and encouraging, avoiding jargon",
  maxWords: 200,
};

export default smithers((ctx) => {
  const brief: Brief = (ctx.input.brief as Brief) ?? DEFAULT_BRIEF;
  const threshold = Number(ctx.input.threshold ?? 85);

  // READ LATEST iteration's critique for loop exit — ctx.latest, NOT ctx.outputMaybe
  const latestCritique = ctx.latest(outputs.critique, "judge") as
    | CritiqueOutput
    | undefined;
  const latestDraft = ctx.latest(outputs.draft, "write") as
    | DraftOutput
    | undefined;

  const score = latestCritique ? Number(latestCritique.score) : -1;
  const isDone = latestCritique?.passed === true || score >= threshold;

  return (
    <Workflow name="content-quality-gate">
      <Loop id="quality-loop" until={isDone} maxIterations={4} onMaxReached="return-last">
        <Sequence>
          <Task id="write" agent={writer} output={outputs.draft} retries={1}>
            {writerPrompt(brief, latestDraft, latestCritique, threshold)}
          </Task>
          <Task
            id="judge"
            agent={judge}
            output={outputs.critique}
            retries={1}
            scorers={{
              "llm-quality": {
                scorer: llmJudge({
                  id: "llm-quality",
                  name: "LLM Quality",
                  description: "editorial quality 0-1",
                  judge: scorerJudgeAgent,
                  instructions:
                    "Rate overall editorial quality 0-1. Return JSON {\"score\":<0-1>,\"reason\":\"...\"}.",
                  promptTemplate: ({ input, output }) =>
                    `Rate this content for editorial quality (0-1). The content is embedded in the following judge task input and output:\n\nINPUT: ${typeof input === "string" ? input.slice(0, 800) : JSON.stringify(input).slice(0, 800)}\n\nJUDGE OUTPUT: ${JSON.stringify(output).slice(0, 400)}`,
                }),
              },
            }}
          >
            {judgePrompt(brief, threshold, latestDraft)}
          </Task>
        </Sequence>
      </Loop>
    </Workflow>
  );
});

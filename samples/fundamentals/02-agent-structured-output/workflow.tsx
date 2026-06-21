/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence, Task, AnthropicAgent } from "smithers-orchestrator";
import { z } from "zod";

// Define the structured output schema for article classification
// Note: z.number() maps to SQLite INTEGER — fractional values (e.g. 0.9) become 1
// Use z.string() for confidence score to preserve decimal precision
const { Workflow, smithers, outputs } = createSmithers({
  classification: z.object({
    category: z.enum(["technology", "politics", "sports", "science", "business", "entertainment", "other"]),
    sentiment: z.enum(["positive", "negative", "neutral"]),
    confidence: z.string().describe("Confidence score from 0.0 to 1.0 as a string to preserve decimals"),
    key_topics: z.array(z.string()).describe("Up to 3 key topics extracted from the text"),
    summary: z.string().describe("One sentence summary of the article"),
  }),
});

const classifyAgent = new AnthropicAgent({
  model: "claude-haiku-4-5",
  instructions: `You are a news article classifier. Given article text, extract structured fields:
- category: the primary topic category
- sentiment: overall emotional tone
- confidence: your confidence in the classification (0.0-1.0 as a string like "0.85")
- key_topics: up to 3 specific topics mentioned (as an array of strings)
- summary: one sentence summary

Always respond with valid JSON matching the schema exactly.`,
  maxOutputTokens: 512,
});

export default smithers((ctx) => (
  <Workflow name="article-classify">
    <Sequence>
      <Task
        id="classify-article"
        output={outputs.classification}
        agent={classifyAgent}
        retries={1}
      >
        {`Classify this article text:\n\n"${ctx.input.text}"`}
      </Task>
    </Sequence>
  </Workflow>
));

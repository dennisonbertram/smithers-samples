/** @jsxImportSource smithers-orchestrator */
import { createSmithers, AnthropicAgent } from "smithers-orchestrator";
import { z } from "zod";

const agent = new AnthropicAgent({ model: "claude-haiku-4-5" });

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  greeting: z.object({
    message: z.string(),
    language: z.string(),
  }),
});

export default smithers((ctx) => (
  <Workflow name="greeting-workflow">
    <Sequence>
      <Task id="greet" output={outputs.greeting} agent={agent}>
        {`Greet the user named "${ctx.input.name}" in ${ctx.input.language ?? "English"}.
Respond ONLY with a JSON object (no markdown, no code fences) in exactly this shape:
{"message": "<your greeting>", "language": "<the language you used>"}`}
      </Task>
    </Sequence>
  </Workflow>
));

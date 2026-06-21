/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence, Task } from "smithers-orchestrator";
import { z } from "zod";

const { Workflow, smithers, outputs } = createSmithers({
  hello: z.object({ message: z.string() }),
});

export default smithers((ctx) => (
  <Workflow name="hello">
    <Sequence>
      <Task id="greet" output={outputs.hello}>
        {{ message: `Hello, ${ctx.input.name}` }}
      </Task>
    </Sequence>
  </Workflow>
));

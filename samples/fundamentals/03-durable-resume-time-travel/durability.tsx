/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence, Task } from "smithers-orchestrator";
import { z } from "zod";

const { Workflow, smithers, outputs } = createSmithers({
  step_a: z.object({ result: z.string(), timestamp: z.string() }),
  step_b: z.object({ result: z.string(), elapsed_ms: z.string() }),
});

export default smithers((ctx) => (
  <Workflow name="durability-demo">
    <Sequence>
      {/* Task A: static — completes immediately, persisted before B starts */}
      <Task id="task-a-static" output={outputs.step_a}>
        {{ result: "Task A complete", timestamp: new Date().toISOString() }}
      </Task>

      {/* Task B: compute with a deliberate 60s sleep to create kill window */}
      <Task
        id="task-b-slow"
        output={outputs.step_b}
      >
        {async () => {
          const start = Date.now();
          await new Promise((resolve) => setTimeout(resolve, 60_000));
          const elapsed = Date.now() - start;
          return { result: "Task B complete after sleep", elapsed_ms: String(elapsed) };
        }}
      </Task>
    </Sequence>
  </Workflow>
));

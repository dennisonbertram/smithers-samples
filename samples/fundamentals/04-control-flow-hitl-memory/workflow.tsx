/** @jsxImportSource smithers-orchestrator */
import {
  createSmithers,
  Sequence,
  Parallel,
  Workflow,
  Task,
  Approval,
  approvalDecisionSchema,
} from "smithers-orchestrator";
import { z } from "zod";

// -----------------------------------------------------------------
// Output schemas
// -----------------------------------------------------------------
const { smithers, outputs } = createSmithers({
  // Parallel fan-out results
  taskA: z.object({ label: z.string(), ts: z.string() }),
  taskB: z.object({ label: z.string(), ts: z.string() }),
  taskC: z.object({ label: z.string(), ts: z.string() }),
  // Approval decision
  gateDecision: approvalDecisionSchema,
  // Post-approval gated result
  gatedResult: z.object({ status: z.string(), approved: z.boolean() }),
  // Memory proof (a static task that records the stored value)
  memoryNote: z.object({ stored: z.string() }),
});

export default smithers((ctx) => {
  // Read approval decision for downstream branch
  const decision = ctx.outputMaybe(outputs.gateDecision, {
    nodeId: "approve-gate",
  });

  return (
    <Workflow name="l3-control-hitl-memory">
      <Sequence>
        {/* ---- 1. Parallel fan-out (maxConcurrency=2, 3 tasks) ---- */}
        <Parallel maxConcurrency={2}>
          <Task id="task-a" output={outputs.taskA}>
            {{ label: "parallel-A", ts: new Date().toISOString() }}
          </Task>
          <Task id="task-b" output={outputs.taskB}>
            {{ label: "parallel-B", ts: new Date().toISOString() }}
          </Task>
          <Task id="task-c" output={outputs.taskC}>
            {{ label: "parallel-C", ts: new Date().toISOString() }}
          </Task>
        </Parallel>

        {/* ---- 2. Approval gate ---- */}
        <Approval
          id="approve-gate"
          output={outputs.gateDecision}
          request={{
            title: "Proceed with gated task?",
            summary:
              "Three parallel tasks completed. Human approval required before continuing.",
          }}
          onDeny="skip"
        />

        {/* ---- 3. Gated task — only runs after approval ---- */}
        {decision ? (
          <Task id="gated-task" output={outputs.gatedResult}>
            {{
              status: decision.approved ? "approved-and-ran" : "denied-skipped",
              approved: decision.approved,
            }}
          </Task>
        ) : null}

        {/* ---- 4. Memory note (static — records that memory was written) ---- */}
        <Task id="memory-note" output={outputs.memoryNote}>
          {{ stored: `memory written at ${new Date().toISOString()}` }}
        </Task>
      </Sequence>
    </Workflow>
  );
});

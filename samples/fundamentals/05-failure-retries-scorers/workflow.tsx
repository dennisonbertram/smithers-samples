/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence, Task, TryCatchFinally, AnthropicAgent } from "smithers-orchestrator";
import { schemaAdherenceScorer, latencyScorer } from "smithers-orchestrator/scorers";
import { z } from "zod";

const model = "claude-haiku-4-5";

const { Workflow, smithers, outputs } = createSmithers({
  flaky_result: z.object({ message: z.string() }),
  recovered:    z.object({ recovered: z.boolean(), reason: z.string() }),
  cleanup:      z.object({ cleanedUp: z.boolean() }),
  scored:       z.object({ summary: z.string(), count: z.number().int() }),
});

const scoredAgent = new AnthropicAgent({
  model,
  instructions: "You are a helpful assistant. Always respond with valid JSON matching the exact schema requested. No extra text.",
});

export default smithers((_ctx) => (
  <Workflow name="l5-failure-obs">
    <Sequence>

      {/*
        L5-1: Failure & retry demo
        A compute task that throws unconditionally → Smithers logs attempts in
        _smithers_attempts (2 rows: attempt 1 + 1 retry), then TryCatchFinally
        catch handler fires with a static task, finally always runs.
      */}
      <TryCatchFinally
        try={
          <Task
            id="failing-compute"
            output={outputs.flaky_result}
            retries={1}
          >
            {() => { throw new Error("Simulated compute failure for L5 retry demo"); }}
          </Task>
        }
        catch={
          <Task
            id="catch-handler"
            output={outputs.recovered}
            continueOnFail
          >
            {{ recovered: true, reason: "caught by TryCatchFinally catch block" }}
          </Task>
        }
        finally={
          <Task id="finally-cleanup" output={outputs.cleanup}>
            {{ cleanedUp: true }}
          </Task>
        }
      />

      {/*
        L5-2 & L5-3: Agent task with schemaAdherenceScorer + latencyScorer
        Provides event stream (NodeStarted, TokenUsageReported, ScorerStarted,
        ScorerFinished) and scorer rows in _smithers_scorers.
      */}
      <Task
        id="scored-summary"
        output={outputs.scored}
        agent={scoredAgent}
        retries={1}
        scorers={{
          schema:   { scorer: schemaAdherenceScorer() },
          latency:  { scorer: latencyScorer({ targetMs: 8000 }) },
        }}
      >
        {`List 3 fruits: apple, banana, cherry.
Return JSON with exactly these fields:
{ "summary": "3 fruits: apple, banana, cherry", "count": 3 }`}
      </Task>

    </Sequence>
  </Workflow>
));

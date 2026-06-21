/** @jsxImportSource smithers-orchestrator */
/**
 * UC1: Durable "fix-until-tests-pass" workflow.
 *
 * Loop structure:
 *   1. implement task (AnthropicAgent, haiku-4-5) — reads failing tests + source, fixes src/slugify.ts
 *   2. test task (compute) — runs `bun test` and parses pass/fail
 *   Loop exits when testResult.passed === true OR maxIterations (5) is hit.
 *
 * Durability: kill mid-run → resume with --run-id RUN_ID --resume true
 *   Smithers skips already-completed tasks and re-runs from the interrupted point.
 */

import {
  createSmithers,
  Sequence,
  Task,
  Loop,
  AnthropicAgent,
  read,
  write,
  edit,
  bash,
} from "smithers-orchestrator";
import { z } from "zod";
import { execSync } from "child_process";

// ── Output schemas ──────────────────────────────────────────────────────────

const { Workflow, smithers, outputs } = createSmithers({
  implementResult: z.object({
    summary: z.string().describe("What the agent changed"),
    filesModified: z.array(z.string()).describe("Relative paths of modified files"),
  }),
  testResult: z.object({
    passed: z.boolean().describe("True when ALL bun tests pass"),
    passCount: z.string().describe("Number of passing tests (as string to avoid SQLite float)"),
    failCount: z.string().describe("Number of failing tests (as string)"),
    output: z.string().describe("Raw bun test output (last 2000 chars)"),
  }),
});

// ── Agent ───────────────────────────────────────────────────────────────────

const implementer = new AnthropicAgent({
  model: "claude-haiku-4-5",
  instructions: `You are a TypeScript bug-fixer.
You will be given the path to a source file and its test file.
Your job is to fix ONLY the source file so that all tests pass.
DO NOT modify the test file.
After reading both files, make the minimal correct fix to the source.
Return a JSON summary of exactly what you changed.`,
  tools: { read, write, edit, bash },
});

// ── Workflow ─────────────────────────────────────────────────────────────────

export default smithers((ctx) => {
  // projectDir defaults to the process cwd so the workflow is robust when run
  // from inside the project (—input '{}'); pass {"projectDir":"/abs/path"} to target elsewhere.
  const projectDir = (ctx.input.projectDir as string) || process.cwd();
  const latestTest = ctx.latest(outputs.testResult, "run-tests");
  const isDone = latestTest?.passed === true;

  return (
    <Workflow name="fix-until-green">
      <Loop id="fix-loop" until={isDone} maxIterations={5}>
        <Sequence>
          <Task
            id="implement"
            output={outputs.implementResult}
            agent={implementer}
            retries={1}
          >
            {`Fix the bug in the TypeScript source file so all Bun tests pass.

Source file: ${projectDir}/src/slugify.ts
Test file:   ${projectDir}/src/slugify.test.ts

Steps:
1. Read src/slugify.ts to understand the current code and the bug comment.
2. Read src/slugify.test.ts to understand what the tests expect.
3. Fix ONLY src/slugify.ts (the bug is on the line with \`+\`  — it should use \`-\`).
4. Return a JSON object with "summary" (what you changed) and "filesModified" (array of relative paths).

Important: your rootDir is ${projectDir}. Use relative paths like "src/slugify.ts".`}
          </Task>

          <Task
            id="run-tests"
            output={outputs.testResult}
            retries={0}
          >
            {async () => {
              let rawOutput = "";
              let exitCode = 0;
              try {
                rawOutput = execSync(
                  `cd "${projectDir}" && bun test src/slugify.test.ts 2>&1`,
                  { encoding: "utf8", timeout: 30000 }
                );
              } catch (err: unknown) {
                exitCode = 1;
                rawOutput = (err as { stdout?: string; stderr?: string; message?: string }).stdout
                  ?? (err as { stdout?: string; stderr?: string; message?: string }).stderr
                  ?? String(err);
              }

              // Parse pass/fail counts from bun test output
              // Bun output: "X pass\nY fail" or "Ran X tests"
              const passMatch = rawOutput.match(/(\d+)\s+pass/);
              const failMatch = rawOutput.match(/(\d+)\s+fail/);
              const passCount = passMatch ? parseInt(passMatch[1], 10) : 0;
              const failCount = failMatch ? parseInt(failMatch[1], 10) : -1;

              const passed = exitCode === 0 && failCount === 0 && passCount > 0;

              return {
                passed,
                passCount: String(passCount),
                failCount: String(failCount < 0 ? "unknown" : failCount),
                output: rawOutput.slice(-2000),
              };
            }}
          </Task>
        </Sequence>
      </Loop>
    </Workflow>
  );
});

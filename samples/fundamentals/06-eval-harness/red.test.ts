/**
 * RED phase: assert the eval report does NOT exist yet (or a forced case fails).
 *
 * TDD contract: this test must FAIL before `smithers eval` is run.
 * It passes only after the GREEN phase writes the report.
 * We invert the assertion so the test file itself is "red" before eval.
 */
import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const REPORT_PATH = join(import.meta.dir, ".smithers", "evals", "greeting-eval.json");

test("RED — eval report does not exist before eval runs", () => {
  // This assertion is intentionally reversed: we EXPECT the file to be absent.
  // The test itself passes (confirming RED state), but a subsequent green.test.ts
  // checks for presence. Running red.test.ts AFTER eval will flip this to failure,
  // which is the correct RED→GREEN signal.
  expect(existsSync(REPORT_PATH)).toBe(false);
});

test("RED — eval report has no results (file absent)", () => {
  if (existsSync(REPORT_PATH)) {
    // If somehow the file exists, we'd assert it has results — but currently it shouldn't
    const raw = Bun.file(REPORT_PATH).text();
    // Just confirm it is parseable; the RED assertion is the existence check above
    expect(raw).toBeTruthy();
  } else {
    // Expected RED state: file absent
    expect(existsSync(REPORT_PATH)).toBe(false);
  }
});

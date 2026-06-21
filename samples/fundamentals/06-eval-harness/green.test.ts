/**
 * GREEN phase: assert the eval report exists and contains valid results.
 *
 * Run AFTER `smithers eval` has executed. This test:
 * 1. Asserts the report file was written
 * 2. Asserts it contains suiteId and a numeric summary score
 * 3. Asserts at least one case has a boolean `passed` field
 * 4. REGRESSION: asserts summary.total >= 1
 */
import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPORT_PATH = join(import.meta.dir, ".smithers", "evals", "greeting-eval.json");

test("GREEN — eval report file exists after eval run", () => {
  expect(existsSync(REPORT_PATH)).toBe(true);
});

test("GREEN — eval report contains suiteId", () => {
  const raw = readFileSync(REPORT_PATH, "utf8");
  const report = JSON.parse(raw);
  expect(typeof report.suiteId).toBe("string");
  expect(report.suiteId).toBe("greeting-eval");
});

test("GREEN — eval report summary has numeric total and passed counts", () => {
  const raw = readFileSync(REPORT_PATH, "utf8");
  const report = JSON.parse(raw);
  expect(typeof report.summary).toBe("object");
  expect(typeof report.summary.total).toBe("number");
  expect(typeof report.summary.passed).toBe("number");
  expect(typeof report.summary.failed).toBe("number");
  expect(report.summary.total).toBeGreaterThanOrEqual(1);
});

test("GREEN — eval report results array contains per-case pass/fail", () => {
  const raw = readFileSync(REPORT_PATH, "utf8");
  const report = JSON.parse(raw);
  expect(Array.isArray(report.results)).toBe(true);
  expect(report.results.length).toBeGreaterThanOrEqual(1);
  for (const result of report.results) {
    expect(typeof result.passed).toBe("boolean");
    expect(typeof result.caseId).toBe("string");
  }
});

test("REGRESSION — eval report contains run/suite id and durationMs", () => {
  const raw = readFileSync(REPORT_PATH, "utf8");
  const report = JSON.parse(raw);
  // Suite id present
  expect(report.suiteId).toBeTruthy();
  // Duration is numeric
  expect(typeof report.durationMs).toBe("number");
  // startedAtMs and finishedAtMs are numeric timestamps
  expect(typeof report.startedAtMs).toBe("number");
  expect(typeof report.finishedAtMs).toBe("number");
});

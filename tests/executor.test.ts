import { describe, expect, it } from "vitest";
import { runRegressionCases } from "@/lib/regression/executor";
import { SEED_CASES } from "@/lib/regression/seed";
import { runTestsRequestSchema } from "@/lib/regression/schema";

describe("runRegressionCases", () => {
  it("seed cases yield 2 passed and 1 failed", () => {
    const report = runRegressionCases(SEED_CASES);
    expect(report.summary).toEqual({ total: 3, passed: 2, failed: 1 });
    expect(report.results.map((r) => r.status)).toEqual(["pass", "fail", "pass"]);
  });

  it("the 3-hour case fails because legacy returns false", () => {
    const failing = runRegressionCases(SEED_CASES).results[1];
    expect(failing.actualAllowed).toBe(false);
    expect(failing.expectedAllowed).toBe(true);
    expect(failing.explanation).toContain("expects cancellation to be allowed");
  });

  it("calls the supplied function rather than fabricating results", () => {
    const calls: number[] = [];
    const report = runRegressionCases([{ hoursBeforeStart: 5, expectedAllowed: true }], (h) => {
      calls.push(h);
      return true;
    });
    expect(calls).toEqual([5]);
    expect(report.results[0].status).toBe("pass");
  });

  it("handles boundaries at 2h and 24h against the legacy rule", () => {
    const report = runRegressionCases([
      { hoursBeforeStart: 2, expectedAllowed: true },
      { hoursBeforeStart: 24, expectedAllowed: true },
      { hoursBeforeStart: 23.99, expectedAllowed: true },
    ]);
    expect(report.results.map((r) => r.status)).toEqual(["fail", "pass", "fail"]);
  });

  it("handles an empty list", () => {
    expect(runRegressionCases([]).summary).toEqual({ total: 0, passed: 0, failed: 0 });
  });
});

describe("runTestsRequestSchema", () => {
  const ok = { hoursBeforeStart: 1, expectedAllowed: false };
  it("accepts valid input and boundary values", () => {
    expect(runTestsRequestSchema.safeParse({ cases: [ok] }).success).toBe(true);
    expect(runTestsRequestSchema.safeParse({ cases: [{ ...ok, hoursBeforeStart: 0 }] }).success).toBe(true);
    expect(runTestsRequestSchema.safeParse({ cases: [{ ...ok, hoursBeforeStart: 10000 }] }).success).toBe(true);
  });
  it("rejects invalid hours", () => {
    for (const h of [-1, 10001, Infinity, NaN]) {
      expect(runTestsRequestSchema.safeParse({ cases: [{ ...ok, hoursBeforeStart: h }] }).success).toBe(false);
    }
  });
  it("rejects more than 20 cases, empty, and non-boolean expected", () => {
    expect(runTestsRequestSchema.safeParse({ cases: Array(21).fill(ok) }).success).toBe(false);
    expect(runTestsRequestSchema.safeParse({ cases: Array(20).fill(ok) }).success).toBe(true);
    expect(runTestsRequestSchema.safeParse({ cases: [] }).success).toBe(false);
    expect(runTestsRequestSchema.safeParse({ cases: [{ hoursBeforeStart: 1, expectedAllowed: "yes" }] }).success).toBe(false);
  });
});

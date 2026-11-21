import { describe, expect, it } from "vitest";
import { canCancelBooking } from "@/lib/legacy/cancellation";
import { runRegressionCases } from "@/lib/regression/executor";
import { runTestsRequestSchema } from "@/lib/regression/schema";
import { explainDirection, explainMismatch } from "@/lib/report/evidence";
import {
  DEFAULT_SCENARIO_THRESHOLD,
  describeProposedRule,
  generateBoundaryCases,
  proposedRuleAllows,
  scenarioCases,
  scenarioThresholdSchema,
} from "@/lib/scenario/boundary";

const hours = (t: number) => scenarioCases(t).map((c) => c.hoursBeforeStart);
const expected = (t: number) => scenarioCases(t).map((c) => c.expectedAllowed);

describe("scenarioThresholdSchema", () => {
  it.each([0, 1, 2, 24, 168])("accepts %s", (t) => {
    expect(scenarioThresholdSchema.safeParse(t).success).toBe(true);
  });
  it.each([-1, 169, 2.5, NaN, Infinity, -Infinity])("rejects %s", (t) => {
    expect(scenarioThresholdSchema.safeParse(t).success).toBe(false);
  });
  it("rejects non-numbers", () => {
    expect(scenarioThresholdSchema.safeParse("2").success).toBe(false);
  });
  it("defaults to 2 hours", () => {
    expect(DEFAULT_SCENARIO_THRESHOLD).toBe(2);
  });
});

describe("generateBoundaryCases", () => {
  it.each([
    [0, [0, 1, 23, 24, 48]],
    [1, [0, 1, 2, 23, 24, 48]],
    [2, [0, 1, 2, 3, 23, 24, 48]],
    [23, [0, 22, 23, 24, 48]],
    [24, [0, 23, 24, 25, 48]],
    [25, [0, 23, 24, 25, 26, 49]],
    [48, [0, 23, 24, 47, 48, 49, 72]],
    [168, [0, 23, 24, 167, 168, 169, 192]],
  ])("threshold %s produces inputs %j", (t, inputs) => {
    expect(hours(t)).toEqual(inputs);
  });

  it("states expectations with the proposed rule only", () => {
    expect(expected(2)).toEqual([false, false, true, true, true, true, true]);
    expect(expected(0).every(Boolean)).toBe(true);
    for (const t of [0, 1, 2, 23, 24, 25, 48, 168]) {
      for (const c of scenarioCases(t)) expect(c.expectedAllowed).toBe(proposedRuleAllows(c.hoursBeforeStart, t));
    }
  });

  it("merges notes for duplicate inputs and drops negatives", () => {
    const zero = generateBoundaryCases(0)[0];
    expect(zero.hoursBeforeStart).toBe(0);
    expect(zero.notes).toEqual(["Booking starting now", "Exactly at the proposed threshold"]);
    const at24 = generateBoundaryCases(24).find((c) => c.hoursBeforeStart === 24);
    expect(at24?.notes).toEqual(["Exactly at the proposed threshold", "Exactly at the legacy 24-hour threshold"]);
    expect(hours(0).some((h) => h < 0)).toBe(false);
  });

  it("is deterministic", () => {
    expect(generateBoundaryCases(7)).toEqual(generateBoundaryCases(7));
  });

  it("throws on invalid thresholds instead of guessing", () => {
    for (const t of [-1, 169, 2.5, NaN]) expect(() => generateBoundaryCases(t)).toThrow(RangeError);
  });

  it("always produces input accepted by /api/run-tests", () => {
    for (let t = 0; t <= 168; t++) {
      expect(runTestsRequestSchema.safeParse({ cases: scenarioCases(t) }).success).toBe(true);
    }
  });

  it("scenarioCases strips display-only notes", () => {
    expect(Object.keys(scenarioCases(2)[0]).sort()).toEqual(["expectedAllowed", "hoursBeforeStart"]);
  });

  it("describes the proposed rule", () => {
    expect(describeProposedRule(6)).toBe("Cancellation allowed if hoursBeforeStart >= 6");
  });
});

describe("scenario cases against the real legacy function", () => {
  it("T=2: 4 passed, 3 failed (2, 3 and 23 hours)", () => {
    const report = runRegressionCases(scenarioCases(2));
    expect(report.summary).toEqual({ total: 7, passed: 4, failed: 3 });
    expect(report.results.filter((r) => r.status === "fail").map((r) => r.hoursBeforeStart)).toEqual([2, 3, 23]);
  });

  it("T=24: no regression", () => {
    const report = runRegressionCases(scenarioCases(24));
    expect(report.summary.failed).toBe(0);
  });

  it("T=48: failures in the permissive direction", () => {
    const report = runRegressionCases(scenarioCases(48));
    const failures = report.results.filter((r) => r.status === "fail");
    expect(failures.map((r) => r.hoursBeforeStart)).toEqual([24, 47]);
    for (const f of failures) {
      expect(f.expectedAllowed).toBe(false);
      expect(f.actualAllowed).toBe(true);
    }
  });

  it("actual outcomes are exactly what canCancelBooking returns", () => {
    for (const t of [0, 2, 25, 168]) {
      for (const r of runRegressionCases(scenarioCases(t)).results) {
        expect(r.actualAllowed).toBe(canCancelBooking(r.hoursBeforeStart));
      }
    }
  });
});

describe("failure explanations in both directions", () => {
  it("stricter legacy rule (expected allowed, actually blocked)", () => {
    const fail = runRegressionCases(scenarioCases(2)).results.find((r) => r.hoursBeforeStart === 3)!;
    expect(explainMismatch(fail)).toContain("expects cancellation to be allowed at 3 hours");
    expect(explainMismatch(fail)).toContain("returned false, because 3 is below the 24-hour threshold");
    expect(explainDirection(fail)).toBe(
      "The legacy rule is stricter here: it blocks a cancellation the test expects to be allowed.",
    );
  });

  it("more permissive legacy rule (expected blocked, actually allowed)", () => {
    const fail = runRegressionCases(scenarioCases(48)).results.find((r) => r.hoursBeforeStart === 47)!;
    expect(explainMismatch(fail)).toContain("expects cancellation to be blocked at 47 hours");
    expect(explainMismatch(fail)).toContain("returned true, because 47 meets the 24-hour threshold");
    expect(explainDirection(fail)).toBe(
      "The legacy rule is more permissive here: it allows a cancellation the test expects to be blocked.",
    );
  });

  it("never names a hardcoded new-requirement threshold", () => {
    const fail = runRegressionCases(scenarioCases(48)).results.find((r) => r.status === "fail")!;
    expect(`${explainMismatch(fail)} ${explainDirection(fail)}`).not.toMatch(/2-hour/);
  });
});

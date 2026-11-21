import { describe, expect, it } from "vitest";
import { runRegressionCases } from "@/lib/regression/executor";
import { NEW_REQUIREMENT, OLD_REQUIREMENT, SEED_CASES } from "@/lib/regression/seed";
import type { RegressionCase } from "@/lib/regression/types";
import { createEvidenceSnapshot, type EvidenceSnapshot, type SnapshotInput } from "@/lib/report/evidence";
import { describeVerdict, shouldNavigateToResults, verdictForDisplay } from "@/lib/report/verdict";
import { scenarioCases } from "@/lib/scenario/boundary";

function snapshot(
  source: SnapshotInput["source"],
  cases: readonly RegressionCase[],
  extra: Partial<SnapshotInput> = {},
): EvidenceSnapshot {
  const copy = cases.map((c) => ({ ...c }));
  return createEvidenceSnapshot({
    executedAt: new Date("2026-11-21T12:00:00.000Z"),
    source,
    oldRequirement: OLD_REQUIREMENT,
    newRequirement: NEW_REQUIREMENT,
    cases: copy,
    report: runRegressionCases(copy),
    ...extra,
  });
}

const aiContext = (n: number) => ({ changeSummary: "x", reasons: Array.from({ length: n }, (_, i) => `r${i}`) });

describe("describeVerdict: failing runs", () => {
  it("seeded demo: regression detected, 1 of 3", () => {
    expect(describeVerdict(snapshot("seeded", SEED_CASES))).toEqual({
      tone: "regression",
      title: "Regression detected",
      detail: "1 of 3 test cases failed",
      note: null,
      failed: 1,
      total: 3,
    });
  });

  it("scenario T=2: regression detected, 3 of 7", () => {
    const v = describeVerdict(snapshot("scenario", scenarioCases(2), { scenario: { thresholdHours: 2 } }));
    expect(v.tone).toBe("regression");
    expect(v.title).toBe("Regression detected");
    expect(v.detail).toBe("3 of 7 test cases failed");
  });

  it("singular wording for a single case", () => {
    const v = describeVerdict(snapshot("seeded", [{ hoursBeforeStart: 3, expectedAllowed: true }]));
    expect(v.detail).toBe("1 of 1 test case failed");
  });
});

describe("describeVerdict: passing runs (zero failures)", () => {
  it("scenario T=24: all tests passed, 0 of 5", () => {
    const v = describeVerdict(snapshot("scenario", scenarioCases(24), { scenario: { thresholdHours: 24 } }));
    expect(v).toEqual({
      tone: "pass",
      title: "All tests passed",
      detail: "0 of 5 test cases failed",
      note: null,
      failed: 0,
      total: 5,
    });
  });

  it("seeded cases that all pass", () => {
    const v = describeVerdict(snapshot("seeded", [{ hoursBeforeStart: 1, expectedAllowed: false }]));
    expect(v.tone).toBe("pass");
    expect(v.detail).toBe("0 of 1 test case failed");
  });

  it("Gemini cases that all pass are not called a mismatch", () => {
    const cases = [
      { hoursBeforeStart: 1, expectedAllowed: false },
      { hoursBeforeStart: 24, expectedAllowed: true },
      { hoursBeforeStart: 48, expectedAllowed: true },
      { hoursBeforeStart: 0, expectedAllowed: false },
      { hoursBeforeStart: 100, expectedAllowed: true },
    ];
    const v = describeVerdict(snapshot("ai", cases, { aiContext: aiContext(5) }));
    expect(v.tone).toBe("pass");
    expect(v.title).toBe("All tests passed");
    expect(v.detail).toBe("0 of 5 test cases failed");
  });
});

describe("describeVerdict: Gemini runs never claim a confirmed regression", () => {
  const cases = [
    { hoursBeforeStart: 1, expectedAllowed: false },
    { hoursBeforeStart: 2, expectedAllowed: true },
    { hoursBeforeStart: 3, expectedAllowed: true },
    { hoursBeforeStart: 24, expectedAllowed: true },
    { hoursBeforeStart: 48, expectedAllowed: true },
  ];

  it("says 'Mismatch detected' with a review note", () => {
    const v = describeVerdict(snapshot("ai", cases, { aiContext: aiContext(5) }));
    expect(v.tone).toBe("mismatch");
    expect(v.title).toBe("Mismatch detected");
    expect(v.detail).toBe("2 of 5 test cases failed");
    expect(v.note).toMatch(/Gemini-proposed expectations/);
    expect(v.note).toMatch(/Review them/);
  });

  it("never uses the word 'Regression' in the title", () => {
    const v = describeVerdict(snapshot("ai", cases, { aiContext: aiContext(5) }));
    expect(v.title).not.toMatch(/regression/i);
  });
});

describe("verdict comes from executed results only", () => {
  it("counts per-case statuses rather than a stored summary", () => {
    const s = snapshot("seeded", SEED_CASES);
    const tampered = { source: s.source, results: s.results, summary: { total: 3, passed: 3, failed: 0 } };
    expect(describeVerdict(tampered).failed).toBe(1);
  });

  it("matches the executor's own summary for every scenario threshold", () => {
    for (let t = 0; t <= 168; t += 7) {
      const s = snapshot("scenario", scenarioCases(t), { scenario: { thresholdHours: t } });
      const v = describeVerdict(s);
      expect([v.failed, v.total]).toEqual([s.summary.failed, s.summary.total]);
      expect(v.tone).toBe(s.summary.failed === 0 ? "pass" : "regression");
    }
  });
});

describe("shouldNavigateToResults", () => {
  const a = snapshot("seeded", SEED_CASES);
  const b = snapshot("seeded", SEED_CASES);

  it("navigates when a new snapshot arrives", () => {
    expect(shouldNavigateToResults(null, a)).toBe(true);
    expect(shouldNavigateToResults(a, b)).toBe(true);
  });

  it("does not navigate again for the same snapshot or when results are cleared", () => {
    expect(shouldNavigateToResults(a, a)).toBe(false);
    expect(shouldNavigateToResults(a, null)).toBe(false);
    expect(shouldNavigateToResults(null, null)).toBe(false);
  });
});

describe("verdictForDisplay: no duplicate success banner", () => {
  it("passing scenario run: one green verdict carrying the threshold-specific message", () => {
    const v = verdictForDisplay(snapshot("scenario", scenarioCases(24), { scenario: { thresholdHours: 24 } }));
    expect(v.tone).toBe("pass");
    expect(v.title).toBe("All tests passed");
    expect(v.detail).toBe("0 of 5 test cases failed");
    expect(v.note).toBe(
      "No regression detected for a 24-hour threshold: the legacy function matched every expected outcome.",
    );
  });

  it("failing scenario, seeded and Gemini runs are unchanged", () => {
    const scenario = snapshot("scenario", scenarioCases(2), { scenario: { thresholdHours: 2 } });
    expect(verdictForDisplay(scenario)).toEqual(describeVerdict(scenario));
    const seeded = snapshot("seeded", SEED_CASES);
    expect(verdictForDisplay(seeded)).toEqual(describeVerdict(seeded));
    const passingSeeded = snapshot("seeded", [{ hoursBeforeStart: 1, expectedAllowed: false }]);
    expect(verdictForDisplay(passingSeeded).note).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { runRegressionCases } from "@/lib/regression/executor";
import { NEW_REQUIREMENT, OLD_REQUIREMENT, SEED_CASES } from "@/lib/regression/seed";
import type { RegressionCase } from "@/lib/regression/types";
import { createEvidenceSnapshot, toMarkdown, type SnapshotInput } from "@/lib/report/evidence";
import {
  PASS_FAIL_BASIS,
  SEEDED_TEXT_NOTE,
  describeExpectationSource,
  requirementsDifferFromSeedDefaults,
} from "@/lib/report/expectation-source";
import { scenarioCases } from "@/lib/scenario/boundary";

const EXECUTED_AT = new Date("2026-11-21T12:00:00.000Z");
const texts = { oldRequirement: OLD_REQUIREMENT, newRequirement: NEW_REQUIREMENT };

function snapshotFor(input: Omit<SnapshotInput, "executedAt" | "report" | "oldRequirement" | "newRequirement"> & Partial<SnapshotInput>) {
  const cases = input.cases.map((c) => ({ ...c }));
  return createEvidenceSnapshot({
    executedAt: EXECUTED_AT,
    ...texts,
    ...input,
    cases,
    report: runRegressionCases(cases),
  });
}

const aiCases: RegressionCase[] = [
  { hoursBeforeStart: 1, expectedAllowed: false },
  { hoursBeforeStart: 2, expectedAllowed: true },
  { hoursBeforeStart: 3, expectedAllowed: true },
  { hoursBeforeStart: 24, expectedAllowed: true },
  { hoursBeforeStart: 48, expectedAllowed: true },
];
const aiContext = { changeSummary: "24h to 2h.", reasons: ["a", "b", "c", "d", "e"] };

describe("describeExpectationSource", () => {
  it("seeded: fixed demo cases, independent of edited text", () => {
    const s = describeExpectationSource("seeded");
    expect(s.expectedLabel).toBe("Expected (fixed demo case)");
    expect(s.description).toBe(
      "Expected outcomes are fixed demonstration cases, independent of any edits to the requirement text.",
    );
  });

  it("Gemini: AI-proposed, may be incorrect, needs review", () => {
    const s = describeExpectationSource("ai");
    expect(s.expectedLabel).toBe("Expected (proposed by Gemini)");
    expect(s.description).toMatch(/proposed by Gemini/);
    expect(s.description).toMatch(/may be incorrect/);
    expect(s.description).toMatch(/Review them/);
  });

  it("scenario: derived deterministically from the threshold", () => {
    const s = describeExpectationSource("scenario", { thresholdHours: 6 });
    expect(s.expectedLabel).toBe("Expected (rule: hours >= 6)");
    expect(s.description).toBe(
      "Expected outcomes are derived deterministically from the proposed threshold of 6 hours (allowed if hoursBeforeStart >= 6).",
    );
  });

  it("scenario without a threshold is an error, not a guess", () => {
    expect(() => describeExpectationSource("scenario")).toThrow();
  });

  it("only the Gemini description mentions AI", () => {
    expect(describeExpectationSource("seeded").description).not.toMatch(/Gemini|AI/);
    expect(describeExpectationSource("scenario", { thresholdHours: 2 }).description).not.toMatch(/Gemini|AI/);
  });
});

describe("pass/fail wording", () => {
  it("states that actual outcomes come from the legacy function and pass/fail is a comparison", () => {
    expect(PASS_FAIL_BASIS).toBe(
      "Actual outcomes come from executing the real legacy canCancelBooking function. " +
        "Pass/fail is a deterministic comparison between each actual and expected outcome.",
    );
    expect(PASS_FAIL_BASIS).not.toMatch(/not AI claims/);
  });
});

describe("copied Markdown report, per source", () => {
  it("seeded", () => {
    const md = toMarkdown(snapshotFor({ source: "seeded", cases: [...SEED_CASES] }));
    expect(md).toContain("- **Expected outcomes:** Expected outcomes are fixed demonstration cases");
    expect(md).toContain(PASS_FAIL_BASIS);
    expect(md).toContain(SEEDED_TEXT_NOTE);
    expect(md).toContain("- **Expected (fixed demo case):** Cancellation allowed (`true`)");
    expect(md).toContain("| Case | Input (hours) | Expected (fixed demo case) | Actual |");
    expect(md).not.toContain("not AI claims");
  });

  it("Gemini", () => {
    const md = toMarkdown(snapshotFor({ source: "ai", cases: aiCases, aiContext }));
    expect(md).toContain("- **Expected outcomes:** Expected outcomes were proposed by Gemini and may be incorrect.");
    expect(md).toContain(PASS_FAIL_BASIS);
    expect(md).toContain("- **Expected (proposed by Gemini):** Cancellation allowed (`true`)");
    expect(md).toContain("| Case | Input (hours) | Expected (proposed by Gemini) | Actual |");
    expect(md).not.toContain(SEEDED_TEXT_NOTE);
    expect(md).not.toContain("not AI claims");
  });

  it("scenario", () => {
    const md = toMarkdown(snapshotFor({ source: "scenario", cases: scenarioCases(6), scenario: { thresholdHours: 6 } }));
    expect(md).toContain("- **Expected outcomes:** Expected outcomes are derived deterministically from the proposed threshold of 6 hours");
    expect(md).toContain("- **Expected (rule: hours >= 6):** Cancellation allowed (`true`)");
    expect(md).toContain("| Case | Input (hours) | Expected (rule: hours >= 6) | Actual |");
    expect(md).not.toContain(SEEDED_TEXT_NOTE);
    expect(md).not.toContain("Gemini");
  });
});

describe("seeded runs with edited requirement text", () => {
  const edited = {
    oldRequirement: OLD_REQUIREMENT,
    newRequirement: "Customers may cancel their booking if at least 48 hours remain before the booking starts.",
  };

  it("detects text that differs from the seeded defaults", () => {
    expect(requirementsDifferFromSeedDefaults(texts)).toBe(false);
    expect(requirementsDifferFromSeedDefaults(edited)).toBe(true);
    expect(requirementsDifferFromSeedDefaults({ ...texts, oldRequirement: `${OLD_REQUIREMENT} ` })).toBe(true);
  });

  it("the report records the edited text but states the seeded expectations did not change", () => {
    const snapshot = snapshotFor({ source: "seeded", cases: [...SEED_CASES], ...edited });
    const md = toMarkdown(snapshot);
    expect(md).toContain("48 hours remain");
    expect(md).toContain(SEEDED_TEXT_NOTE);
    expect(md).toContain("independent of any edits to the requirement text");
    // The fixed expectations are unchanged by the text edit.
    expect(snapshot.cases).toEqual([...SEED_CASES]);
    expect(snapshot.summary).toEqual({ total: 3, passed: 2, failed: 1 });
  });
});

describe("executor wording", () => {
  it("failure explanations say 'the test expects', never 'the requirement expects'", () => {
    const report = runRegressionCases([...SEED_CASES, ...scenarioCases(48), ...aiCases]);
    const failing = report.results.filter((r) => r.status === "fail");
    expect(failing.length).toBeGreaterThan(0);
    for (const r of failing) {
      expect(r.explanation).toContain("the test expects cancellation to be");
      expect(r.explanation).not.toContain("the requirement expects");
    }
    expect(report.results[1].explanation).toBe(
      "With 3 hours before start, the test expects cancellation to be allowed, but the legacy function returned blocked.",
    );
  });

  it("execution results are unchanged by the wording", () => {
    const report = runRegressionCases(SEED_CASES);
    expect(report.results.map((r) => [r.actualAllowed, r.status])).toEqual([
      [false, "pass"],
      [false, "fail"],
      [true, "pass"],
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { runRegressionCases } from "@/lib/regression/executor";
import { NEW_REQUIREMENT, OLD_REQUIREMENT, SEED_CASES } from "@/lib/regression/seed";
import type { RegressionCase, RunReport } from "@/lib/regression/types";
import {
  EvidenceIntegrityError,
  compareWithDraft,
  createEvidenceSnapshot,
  explainMismatch,
  failedResults,
  isScenarioNoRegression,
  passedResults,
  sourceLabel,
  toMarkdown,
  type SnapshotInput,
} from "@/lib/report/evidence";
import { scenarioCases } from "@/lib/scenario/boundary";

const EXECUTED_AT = new Date("2026-11-21T12:00:00.000Z");

function seededInput(overrides: Partial<SnapshotInput> = {}): SnapshotInput {
  const cases = SEED_CASES.map((c) => ({ ...c }));
  return {
    executedAt: EXECUTED_AT,
    source: "seeded",
    oldRequirement: OLD_REQUIREMENT,
    newRequirement: NEW_REQUIREMENT,
    cases,
    report: runRegressionCases(cases),
    ...overrides,
  };
}

const aiCases: RegressionCase[] = [
  { hoursBeforeStart: 1, expectedAllowed: false },
  { hoursBeforeStart: 2, expectedAllowed: true },
  { hoursBeforeStart: 23, expectedAllowed: true },
  { hoursBeforeStart: 24, expectedAllowed: true },
  { hoursBeforeStart: 100, expectedAllowed: true },
];

function aiInput(): SnapshotInput {
  const cases = aiCases.map((c) => ({ ...c }));
  return {
    executedAt: EXECUTED_AT,
    source: "ai",
    oldRequirement: OLD_REQUIREMENT,
    newRequirement: NEW_REQUIREMENT,
    cases,
    report: runRegressionCases(cases),
    aiContext: {
      changeSummary: "Window reduced from 24h to 2h.",
      reasons: ["Below new threshold.", "At new threshold.", "Between thresholds.", "At old threshold.", "Far ahead."],
    },
  };
}

describe("createEvidenceSnapshot", () => {
  it("records seeded execution evidence from the deterministic executor", () => {
    const s = createEvidenceSnapshot(seededInput());
    expect(s.executedAt).toBe("2026-11-21T12:00:00.000Z");
    expect(s.source).toBe("seeded");
    expect(s.summary).toEqual({ total: 3, passed: 2, failed: 1 });
    expect(failedResults(s).map((r) => r.hoursBeforeStart)).toEqual([3]);
    expect(passedResults(s).map((r) => r.hoursBeforeStart)).toEqual([1, 25]);
    expect(s.aiContext).toBeUndefined();
  });

  it("keeps AI context separate from executed results", () => {
    const s = createEvidenceSnapshot(aiInput());
    expect(s.source).toBe("ai");
    expect(s.aiContext?.reasons).toHaveLength(5);
    expect(s.summary).toEqual({ total: 5, passed: 3, failed: 2 });
    expect(failedResults(s).map((r) => r.hoursBeforeStart)).toEqual([2, 23]);
  });

  it("drops non-executable fields from captured cases", () => {
    const withReason = aiCases.map((c) => ({ ...c, reason: "x" }));
    const s = createEvidenceSnapshot({ ...aiInput(), cases: withReason });
    expect(Object.keys(s.cases[0]).sort()).toEqual(["expectedAllowed", "hoursBeforeStart"]);
  });

  it("rejects results that do not belong to the submitted cases", () => {
    const input = seededInput();
    const otherReport = runRegressionCases([{ hoursBeforeStart: 50, expectedAllowed: true }, ...SEED_CASES.slice(1)]);
    expect(() => createEvidenceSnapshot({ ...input, report: otherReport })).toThrow(EvidenceIntegrityError);
    expect(() => createEvidenceSnapshot({ ...input, cases: input.cases.slice(0, 2) })).toThrow(EvidenceIntegrityError);
  });

  it("rejects a relabeled status or tampered summary", () => {
    const input = seededInput();
    const relabeled: RunReport = structuredClone(input.report);
    relabeled.results[1].status = "pass";
    expect(() => createEvidenceSnapshot({ ...input, report: relabeled })).toThrow(EvidenceIntegrityError);

    const tampered: RunReport = structuredClone(input.report);
    tampered.summary.failed = 0;
    expect(() => createEvidenceSnapshot({ ...input, report: tampered })).toThrow(EvidenceIntegrityError);
  });

  it("rejects AI reasons that do not align with the cases", () => {
    const input = aiInput();
    expect(() =>
      createEvidenceSnapshot({ ...input, aiContext: { changeSummary: "x", reasons: ["only one"] } }),
    ).toThrow(EvidenceIntegrityError);
  });
});

describe("snapshot immutability", () => {
  it("is unaffected by later mutation of its inputs", () => {
    const input = aiInput();
    const s = createEvidenceSnapshot(input);
    input.cases[0].hoursBeforeStart = 999;
    input.report.results[1].status = "pass";
    input.report.summary.failed = 0;
    input.aiContext!.reasons[0] = "edited";
    input.oldRequirement = "edited";
    expect(s.cases[0].hoursBeforeStart).toBe(1);
    expect(s.results[1].status).toBe("fail");
    expect(s.summary.failed).toBe(2);
    expect(s.aiContext?.reasons[0]).toBe("Below new threshold.");
    expect(s.oldRequirement).toBe(OLD_REQUIREMENT);
  });

  it("is deeply frozen", () => {
    const s = createEvidenceSnapshot(aiInput());
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.results)).toBe(true);
    expect(Object.isFrozen(s.results[0])).toBe(true);
    expect(Object.isFrozen(s.cases[0])).toBe(true);
    expect(Object.isFrozen(s.summary)).toBe(true);
    expect(Object.isFrozen(s.aiContext?.reasons)).toBe(true);
    expect(() => {
      (s.results[0] as { status: string }).status = "fail";
    }).toThrow(TypeError);
  });
});

describe("compareWithDraft", () => {
  it("is not stale when the draft matches the captured inputs", () => {
    const s = createEvidenceSnapshot(seededInput());
    expect(compareWithDraft(s, { oldRequirement: OLD_REQUIREMENT, newRequirement: NEW_REQUIREMENT, generatedCases: null })).toEqual({
      requirementsChanged: false,
      casesChanged: false,
      isStale: false,
    });
  });

  it("flags edited requirement text", () => {
    const s = createEvidenceSnapshot(seededInput());
    const d = compareWithDraft(s, { oldRequirement: OLD_REQUIREMENT, newRequirement: "changed", generatedCases: null });
    expect(d).toMatchObject({ requirementsChanged: true, isStale: true });
  });

  it("ignores AI cases for seeded evidence", () => {
    const s = createEvidenceSnapshot(seededInput());
    const d = compareWithDraft(s, { oldRequirement: OLD_REQUIREMENT, newRequirement: NEW_REQUIREMENT, generatedCases: aiCases });
    expect(d.isStale).toBe(false);
  });

  it("flags regenerated or cleared AI cases for AI evidence", () => {
    const s = createEvidenceSnapshot(aiInput());
    const base = { oldRequirement: OLD_REQUIREMENT, newRequirement: NEW_REQUIREMENT };
    expect(compareWithDraft(s, { ...base, generatedCases: aiCases }).isStale).toBe(false);
    expect(compareWithDraft(s, { ...base, generatedCases: null }).casesChanged).toBe(true);
    const changed = aiCases.map((c, i) => (i === 0 ? { ...c, hoursBeforeStart: 0.5 } : c));
    expect(compareWithDraft(s, { ...base, generatedCases: changed }).casesChanged).toBe(true);
    expect(compareWithDraft(s, { ...base, generatedCases: aiCases.slice(1) }).casesChanged).toBe(true);
  });
});

describe("explainMismatch", () => {
  it("explains the 3-hour failure deterministically from the legacy threshold", () => {
    const s = createEvidenceSnapshot(seededInput());
    expect(explainMismatch(failedResults(s)[0])).toBe(
      "The test expects cancellation to be allowed at 3 hours before start. The legacy canCancelBooking function " +
        "(rule: hoursBeforeStart >= 24) returned false, because 3 is below the 24-hour threshold.",
    );
  });

  it("handles the singular hour and a value at the threshold", () => {
    const report = runRegressionCases([
      { hoursBeforeStart: 1, expectedAllowed: true },
      { hoursBeforeStart: 24, expectedAllowed: false },
    ]);
    expect(explainMismatch(report.results[0])).toContain("at 1 hour before start");
    expect(explainMismatch(report.results[1])).toContain("returned true, because 24 meets the 24-hour threshold");
  });
});

describe("toMarkdown", () => {
  it("renders the seeded report exactly", () => {
    const md = toMarkdown(createEvidenceSnapshot(seededInput()));
    expect(md).toBe(
      [
        "# SpecShift Proof: Regression Evidence Report",
        "",
        "- **Executed at:** 2026-11-21T12:00:00.000Z",
        "- **Test source:** Seeded demo cases",
        "- **Function under test:** `canCancelBooking` (legacy rule: `hoursBeforeStart >= 24`)",
        "- **Total:** 3 | **Passed:** 2 | **Failed:** 1",
        "- **Expected outcomes:** Expected outcomes are fixed demonstration cases, independent of any edits to the requirement text.",
        "",
        "Actual outcomes come from executing the real legacy canCancelBooking function. Pass/fail is a deterministic comparison between each actual and expected outcome.",
        "",
        "## Requirements at execution time",
        "",
        "**Old requirement**",
        "",
        `> ${OLD_REQUIREMENT}`,
        "",
        "**New requirement**",
        "",
        `> ${NEW_REQUIREMENT}`,
        "",
        "The seeded expectations are fixed demonstration cases. They do not update when the requirement text is edited, so the text above is recorded for context only.",
        "",
        "## Failed cases (1)",
        "",
        "### Case 2: hoursBeforeStart = 3",
        "",
        "- **Input:** `hoursBeforeStart = 3`",
        "- **Expected (fixed demo case):** Cancellation allowed (`true`)",
        "- **Actual:** Cancellation blocked (`false`)",
        "- **Explanation:** The test expects cancellation to be allowed at 3 hours before start. The legacy canCancelBooking function (rule: hoursBeforeStart >= 24) returned false, because 3 is below the 24-hour threshold.",
        "",
        "## Passed cases (2)",
        "",
        "| Case | Input (hours) | Expected (fixed demo case) | Actual |",
        "| --- | --- | --- | --- |",
        "| 1 | 1 | Cancellation blocked | Cancellation blocked |",
        "| 3 | 25 | Cancellation allowed | Cancellation allowed |",
        "",
      ].join("\n"),
    );
  });

  it("labels Gemini content as context, not evidence, and includes per-case rationale", () => {
    const md = toMarkdown(createEvidenceSnapshot(aiInput()));
    expect(md).toContain("- **Test source:** Gemini-generated cases");
    expect(md).toContain("## Gemini change summary (context only, not evidence)\n\n> Window reduced from 24h to 2h.");
    expect(md).toContain("- **Gemini's rationale for this case:** At new threshold.");
    expect(md).toContain("## Failed cases (2)");
    expect(md).toContain("## Passed cases (3)");
  });

  it("quotes multi-line requirements line by line", () => {
    const md = toMarkdown(createEvidenceSnapshot(seededInput({ oldRequirement: "Line one\nLine two" })));
    expect(md).toContain("**Old requirement**\n\n> Line one\n> Line two\n");
  });

  it("states when there are no failures or no passes", () => {
    const allPass = [{ hoursBeforeStart: 30, expectedAllowed: true }];
    const allFail = [{ hoursBeforeStart: 3, expectedAllowed: true }];
    const mdPass = toMarkdown(createEvidenceSnapshot(seededInput({ cases: allPass, report: runRegressionCases(allPass) })));
    const mdFail = toMarkdown(createEvidenceSnapshot(seededInput({ cases: allFail, report: runRegressionCases(allFail) })));
    expect(mdPass).toContain("## Failed cases (0)\n\nNo failures.");
    expect(mdFail).toContain("## Passed cases (0)\n\nNo passing cases.");
  });

  it("is deterministic", () => {
    const s = createEvidenceSnapshot(aiInput());
    expect(toMarkdown(s)).toBe(toMarkdown(s));
  });
});

// ---------------------------------------------------------------------------
// Scenario-editor evidence
// ---------------------------------------------------------------------------

function scenarioInput(thresholdHours: number, overrides: Partial<SnapshotInput> = {}): SnapshotInput {
  const cases = scenarioCases(thresholdHours);
  return {
    executedAt: EXECUTED_AT,
    source: "scenario",
    oldRequirement: OLD_REQUIREMENT,
    newRequirement: NEW_REQUIREMENT,
    cases,
    report: runRegressionCases(cases),
    scenario: { thresholdHours },
    ...overrides,
  };
}

describe("scenario evidence snapshots", () => {
  it("records the threshold, source and executor results", () => {
    const s = createEvidenceSnapshot(scenarioInput(2));
    expect(s.source).toBe("scenario");
    expect(s.scenario).toEqual({ thresholdHours: 2 });
    expect(s.aiContext).toBeUndefined();
    expect(s.summary).toEqual({ total: 7, passed: 4, failed: 3 });
    expect(Object.isFrozen(s.scenario)).toBe(true);
    expect(sourceLabel(s.source)).toBe("Scenario editor (deterministic boundary cases)");
  });

  it("is unaffected by later mutation of the scenario input", () => {
    const input = scenarioInput(6);
    const s = createEvidenceSnapshot(input);
    input.scenario!.thresholdHours = 12;
    expect(s.scenario?.thresholdHours).toBe(6);
  });

  it("rejects cases that do not match the chosen threshold", () => {
    const cases = scenarioCases(6);
    expect(() =>
      createEvidenceSnapshot(scenarioInput(2, { cases, report: runRegressionCases(cases) })),
    ).toThrow(EvidenceIntegrityError);

    const edited = scenarioCases(2).map((c, i) => (i === 2 ? { ...c, expectedAllowed: false } : c));
    expect(() =>
      createEvidenceSnapshot(scenarioInput(2, { cases: edited, report: runRegressionCases(edited) })),
    ).toThrow(EvidenceIntegrityError);

    const missing = scenarioCases(2).slice(1);
    expect(() =>
      createEvidenceSnapshot(scenarioInput(2, { cases: missing, report: runRegressionCases(missing) })),
    ).toThrow(EvidenceIntegrityError);
  });

  it("rejects invalid or missing scenario thresholds", () => {
    expect(() => createEvidenceSnapshot(scenarioInput(2, { scenario: undefined }))).toThrow(EvidenceIntegrityError);
    expect(() => createEvidenceSnapshot(scenarioInput(2, { scenario: { thresholdHours: 2.5 } }))).toThrow(
      EvidenceIntegrityError,
    );
    expect(() => createEvidenceSnapshot(scenarioInput(2, { scenario: { thresholdHours: 169 } }))).toThrow(
      EvidenceIntegrityError,
    );
  });

  it("keeps sources separate", () => {
    expect(() => createEvidenceSnapshot(seededInput({ scenario: { thresholdHours: 2 } }))).toThrow(
      EvidenceIntegrityError,
    );
    expect(() =>
      createEvidenceSnapshot(scenarioInput(2, { aiContext: { changeSummary: "x", reasons: Array(7).fill("r") } })),
    ).toThrow(EvidenceIntegrityError);
  });
});

describe("scenario staleness", () => {
  const base = { oldRequirement: OLD_REQUIREMENT, newRequirement: NEW_REQUIREMENT, generatedCases: null };

  it("is current when the threshold and text are unchanged", () => {
    expect(compareWithDraft(createEvidenceSnapshot(scenarioInput(2)), { ...base, scenarioThreshold: 2 }).isStale).toBe(
      false,
    );
  });

  it("is stale when the threshold changes or becomes invalid", () => {
    const s = createEvidenceSnapshot(scenarioInput(2));
    expect(compareWithDraft(s, { ...base, scenarioThreshold: 3 })).toMatchObject({ casesChanged: true, isStale: true });
    expect(compareWithDraft(s, { ...base, scenarioThreshold: null }).isStale).toBe(true);
  });

  it("is stale when the requirement text changes", () => {
    const s = createEvidenceSnapshot(scenarioInput(2));
    expect(compareWithDraft(s, { ...base, newRequirement: "edited", scenarioThreshold: 2 })).toMatchObject({
      requirementsChanged: true,
      casesChanged: false,
      isStale: true,
    });
  });

  it("ignores AI cases for scenario evidence, and the threshold for other sources", () => {
    const scenario = createEvidenceSnapshot(scenarioInput(2));
    expect(compareWithDraft(scenario, { ...base, generatedCases: aiCases, scenarioThreshold: 2 }).isStale).toBe(false);
    const seeded = createEvidenceSnapshot(seededInput());
    expect(compareWithDraft(seeded, { ...base, scenarioThreshold: 99 }).isStale).toBe(false);
    const ai = createEvidenceSnapshot(aiInput());
    expect(compareWithDraft(ai, { ...base, generatedCases: aiCases, scenarioThreshold: 99 }).isStale).toBe(false);
  });
});

describe("scenario Markdown", () => {
  it("separates the proposed rule from the written requirements", () => {
    const md = toMarkdown(createEvidenceSnapshot(scenarioInput(6)));
    expect(md).toContain("- **Test source:** Scenario editor (deterministic boundary cases)");
    expect(md).toContain(
      [
        "## Proposed scenario rule (determines expected outcomes)",
        "",
        "- **Threshold:** 6 hours",
        "- **Rule:** Cancellation allowed if hoursBeforeStart >= 6",
        "",
        "Expected outcomes come from this numeric rule, set in the scenario editor. The written requirements above are recorded for context only and were not interpreted.",
      ].join("\n"),
    );
    expect(md.indexOf("## Requirements at execution time")).toBeLessThan(md.indexOf("## Proposed scenario rule"));
    expect(md).not.toContain("Gemini");
  });

  it("states no regression when every scenario case passes", () => {
    const s = createEvidenceSnapshot(scenarioInput(24));
    expect(isScenarioNoRegression(s)).toBe(true);
    expect(toMarkdown(s)).toContain(
      "## Failed cases (0)\n\nNo regression detected for a 24-hour threshold: the legacy function matched every expected outcome.",
    );
  });

  it("does not claim no regression when cases fail, or for other sources", () => {
    expect(isScenarioNoRegression(createEvidenceSnapshot(scenarioInput(2)))).toBe(false);
    const allPass = [{ hoursBeforeStart: 30, expectedAllowed: true }];
    const seeded = createEvidenceSnapshot(seededInput({ cases: allPass, report: runRegressionCases(allPass) }));
    expect(isScenarioNoRegression(seeded)).toBe(false);
    expect(toMarkdown(seeded)).not.toContain("No regression detected");
  });

  it("does not add scenario sections to seeded or Gemini reports", () => {
    expect(toMarkdown(createEvidenceSnapshot(seededInput()))).not.toContain("Proposed scenario rule");
    expect(toMarkdown(createEvidenceSnapshot(aiInput()))).not.toContain("Proposed scenario rule");
  });
});

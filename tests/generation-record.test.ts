import { describe, expect, it } from "vitest";
import {
  StaleGenerationError,
  applyGenerationOutcome,
  createGenerationRecord,
  generatedExecutableCases,
  generationMatchesDraft,
  initialGenerationState,
  prepareGeneratedRun,
  type RequirementDraft,
} from "@/lib/ai/generation-record";
import type { GeneratedTests } from "@/lib/ai/schema";
import { runRegressionCases } from "@/lib/regression/executor";
import { runTestsRequestSchema } from "@/lib/regression/schema";
import { NEW_REQUIREMENT, OLD_REQUIREMENT } from "@/lib/regression/seed";
import { compareWithDraft, createEvidenceSnapshot, toMarkdown } from "@/lib/report/evidence";

const textA: RequirementDraft = { oldRequirement: OLD_REQUIREMENT, newRequirement: NEW_REQUIREMENT };
const textB: RequirementDraft = {
  oldRequirement: OLD_REQUIREMENT,
  newRequirement: "Customers may cancel their booking if at least 6 hours remain before the booking starts.",
};

const outputA: GeneratedTests = {
  changeSummary: "Window reduced from 24h to 2h.",
  testCases: [
    { hoursBeforeStart: 1, expectedAllowed: false, reason: "Below 2h." },
    { hoursBeforeStart: 2, expectedAllowed: true, reason: "At 2h." },
    { hoursBeforeStart: 3, expectedAllowed: true, reason: "Above 2h." },
    { hoursBeforeStart: 24, expectedAllowed: true, reason: "Old threshold." },
    { hoursBeforeStart: 48, expectedAllowed: true, reason: "Far ahead." },
  ],
};

const outputB: GeneratedTests = {
  changeSummary: "Window reduced from 24h to 6h.",
  testCases: [
    { hoursBeforeStart: 5, expectedAllowed: false, reason: "Below 6h." },
    { hoursBeforeStart: 6, expectedAllowed: true, reason: "At 6h." },
    { hoursBeforeStart: 7, expectedAllowed: true, reason: "Above 6h." },
    { hoursBeforeStart: 24, expectedAllowed: true, reason: "Old threshold." },
    { hoursBeforeStart: 48, expectedAllowed: true, reason: "Far ahead." },
  ],
};

/** Mirrors the dashboard: run the prepared payload through the executor and snapshot it. */
function executeGenerated(payload: ReturnType<typeof prepareGeneratedRun>) {
  return createEvidenceSnapshot({
    executedAt: new Date("2026-11-21T12:00:00.000Z"),
    source: "ai",
    oldRequirement: payload.requirements.oldRequirement,
    newRequirement: payload.requirements.newRequirement,
    cases: payload.cases,
    report: runRegressionCases(payload.cases),
    aiContext: payload.aiContext,
  });
}

describe("createGenerationRecord", () => {
  it("stores the exact requirement text that was sent", () => {
    const record = createGenerationRecord(textA, outputA);
    expect(record.requirements).toEqual(textA);
    expect(record.output.changeSummary).toBe(outputA.changeSummary);
    expect(record.output.testCases).toEqual(outputA.testCases);
  });

  it("is a deep-frozen copy unaffected by later mutation of its inputs", () => {
    const sent = { ...textA };
    const output = structuredClone(outputA);
    const record = createGenerationRecord(sent, output);
    sent.newRequirement = "edited";
    output.testCases[0].hoursBeforeStart = 99;
    output.changeSummary = "edited";
    expect(record.requirements.newRequirement).toBe(NEW_REQUIREMENT);
    expect(record.output.testCases[0].hoursBeforeStart).toBe(1);
    expect(record.output.changeSummary).toBe(outputA.changeSummary);
    expect(Object.isFrozen(record.requirements)).toBe(true);
    expect(Object.isFrozen(record.output.testCases[0])).toBe(true);
  });
});

describe("requirement edits after generation", () => {
  const record = createGenerationRecord(textA, outputA);

  it("matches only the exact generation inputs", () => {
    expect(generationMatchesDraft(record, textA)).toBe(true);
    expect(generationMatchesDraft(record, { ...textA, oldRequirement: "edited" })).toBe(false);
    expect(generationMatchesDraft(record, { ...textA, newRequirement: "edited" })).toBe(false);
    expect(generationMatchesDraft(record, { ...textA, newRequirement: `${NEW_REQUIREMENT} ` })).toBe(false);
  });

  it("refuses to prepare a run when either requirement changed", () => {
    expect(() => prepareGeneratedRun(record, { ...textA, oldRequirement: "edited" })).toThrow(StaleGenerationError);
    expect(() => prepareGeneratedRun(record, textB)).toThrow(StaleGenerationError);
  });

  it("is runnable again if the text is restored exactly", () => {
    expect(() => prepareGeneratedRun(record, { ...textA })).not.toThrow();
  });
});

describe("evidence snapshot correctness", () => {
  it("uses the stored generation inputs, executable cases and aligned reasons", () => {
    const record = createGenerationRecord(textA, outputA);
    const payload = prepareGeneratedRun(record, { ...textA });
    expect(payload.requirements).toEqual(textA);
    expect(payload.requirements).not.toBe(record.requirements);
    expect(payload.cases).toEqual(generatedExecutableCases(record));
    expect(Object.keys(payload.cases[0]).sort()).toEqual(["expectedAllowed", "hoursBeforeStart"]);
    expect(runTestsRequestSchema.safeParse({ cases: payload.cases }).success).toBe(true);
    expect(payload.aiContext.reasons).toEqual(outputA.testCases.map((c) => c.reason));

    const snapshot = executeGenerated(payload);
    expect(snapshot.oldRequirement).toBe(textA.oldRequirement);
    expect(snapshot.newRequirement).toBe(textA.newRequirement);
    expect(snapshot.aiContext?.changeSummary).toBe(outputA.changeSummary);
    expect(snapshot.summary).toEqual({ total: 5, passed: 3, failed: 2 });
    expect(toMarkdown(snapshot)).toContain(`> ${NEW_REQUIREMENT}`);
  });

  it("evidence is not stale while draft and record match", () => {
    const record = createGenerationRecord(textA, outputA);
    const snapshot = executeGenerated(prepareGeneratedRun(record, textA));
    expect(
      compareWithDraft(snapshot, { ...textA, generatedCases: generatedExecutableCases(record) }).isStale,
    ).toBe(false);
  });
});

describe("generation state transitions", () => {
  it("successful regeneration replaces the record and binds it to the new text", () => {
    const first = createGenerationRecord(textA, outputA);
    let state = applyGenerationOutcome(initialGenerationState, { ok: true, record: first });
    const oldEvidence = executeGenerated(prepareGeneratedRun(first, textA));

    // User edits to text B: the old cases cannot run.
    expect(() => prepareGeneratedRun(state.record!, textB)).toThrow(StaleGenerationError);

    const second = createGenerationRecord(textB, outputB);
    state = applyGenerationOutcome(state, { ok: true, record: second });
    expect(state).toEqual({ record: second, error: null, keptPrevious: false });

    const newEvidence = executeGenerated(prepareGeneratedRun(state.record!, textB));
    expect(newEvidence.newRequirement).toBe(textB.newRequirement);
    expect(newEvidence.cases.map((c) => c.hoursBeforeStart)).toEqual([5, 6, 7, 24, 48]);

    // The earlier evidence is flagged against the new draft and cases, never relabeled.
    const divergence = compareWithDraft(oldEvidence, { ...textB, generatedCases: generatedExecutableCases(second) });
    expect(divergence).toMatchObject({ requirementsChanged: true, casesChanged: true, isStale: true });
    expect(oldEvidence.newRequirement).toBe(NEW_REQUIREMENT);
  });

  it("failed regeneration keeps the previous record untouched and reports the error", () => {
    const first = createGenerationRecord(textA, outputA);
    const before = applyGenerationOutcome(initialGenerationState, { ok: true, record: first });
    const after = applyGenerationOutcome(before, { ok: false, error: "The AI provider request failed." });
    expect(after.record).toBe(first);
    expect(after.record?.requirements).toEqual(textA);
    expect(after.error).toBe("The AI provider request failed.");
    expect(after.keptPrevious).toBe(true);
  });

  it("failed regeneration does not mislabel earlier AI evidence", () => {
    const first = createGenerationRecord(textA, outputA);
    const evidence = executeGenerated(prepareGeneratedRun(first, textA));
    const state = applyGenerationOutcome(
      applyGenerationOutcome(initialGenerationState, { ok: true, record: first }),
      { ok: false, error: "x" },
    );
    expect(
      compareWithDraft(evidence, { ...textA, generatedCases: generatedExecutableCases(state.record!) }).isStale,
    ).toBe(false);
  });

  it("failed regeneration after editing text still blocks the old cases", () => {
    const first = createGenerationRecord(textA, outputA);
    const state = applyGenerationOutcome(
      applyGenerationOutcome(initialGenerationState, { ok: true, record: first }),
      { ok: false, error: "x" },
    );
    expect(() => prepareGeneratedRun(state.record!, textB)).toThrow(StaleGenerationError);
  });

  it("failure with no previous record keeps nothing", () => {
    expect(applyGenerationOutcome(initialGenerationState, { ok: false, error: "x" })).toEqual({
      record: null,
      error: "x",
      keptPrevious: false,
    });
  });

  it("success after a failure clears the error", () => {
    const failed = applyGenerationOutcome(initialGenerationState, { ok: false, error: "x" });
    const record = createGenerationRecord(textA, outputA);
    expect(applyGenerationOutcome(failed, { ok: true, record })).toEqual({ record, error: null, keptPrevious: false });
  });
});

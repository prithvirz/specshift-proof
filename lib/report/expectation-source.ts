import { NEW_REQUIREMENT, OLD_REQUIREMENT } from "@/lib/regression/seed";
import type { EvidenceSource } from "./evidence";

/**
 * Where a run's expected outcomes came from. Actual outcomes always come from executing
 * the legacy function; this only describes the other side of the comparison.
 */
export interface ExpectationSource {
  /** Short label for an "Expected" field or column. */
  expectedLabel: string;
  /** One-sentence description for result headers and reports. */
  description: string;
}

export const PASS_FAIL_BASIS =
  "Actual outcomes come from executing the real legacy canCancelBooking function. " +
  "Pass/fail is a deterministic comparison between each actual and expected outcome.";

export const SEEDED_TEXT_NOTE =
  "The seeded expectations are fixed demonstration cases. They do not update when the requirement text is edited, " +
  "so the text above is recorded for context only.";

export function describeExpectationSource(
  source: EvidenceSource,
  scenario?: { thresholdHours: number },
): ExpectationSource {
  switch (source) {
    case "seeded":
      return {
        expectedLabel: "Expected (fixed demo case)",
        description:
          "Expected outcomes are fixed demonstration cases, independent of any edits to the requirement text.",
      };
    case "ai":
      return {
        expectedLabel: "Expected (proposed by Gemini)",
        description:
          "Expected outcomes were proposed by Gemini and may be incorrect. Review them before treating a failure as a regression.",
      };
    case "scenario": {
      if (!scenario) throw new Error("Scenario expectations require a threshold.");
      const t = scenario.thresholdHours;
      return {
        expectedLabel: `Expected (rule: hours >= ${t})`,
        description: `Expected outcomes are derived deterministically from the proposed threshold of ${t} hours (allowed if hoursBeforeStart >= ${t}).`,
      };
    }
  }
}

/** True when the requirement text no longer matches the text the seeded cases were written for. */
export function requirementsDifferFromSeedDefaults(draft: { oldRequirement: string; newRequirement: string }): boolean {
  return draft.oldRequirement !== OLD_REQUIREMENT || draft.newRequirement !== NEW_REQUIREMENT;
}

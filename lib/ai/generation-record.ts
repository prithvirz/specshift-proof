import type { RegressionCase } from "@/lib/regression/types";
import type { AiContext } from "@/lib/report/evidence";
import type { GenerateTestsRequest, GeneratedTests } from "./schema";

/**
 * Client-side record of one successful Gemini generation, bound to the exact
 * requirement text that was sent. Deep-frozen so it cannot drift from its inputs.
 */
export interface GenerationRecord {
  readonly requirements: Readonly<GenerateTestsRequest>;
  readonly output: Readonly<{
    changeSummary: string;
    testCases: readonly Readonly<GeneratedTests["testCases"][number]>[];
  }>;
}

export interface RequirementDraft {
  oldRequirement: string;
  newRequirement: string;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

/** `sent` must be the exact request body sent to /api/generate-tests, captured before the request. */
export function createGenerationRecord(sent: RequirementDraft, output: GeneratedTests): GenerationRecord {
  return deepFreeze(
    structuredClone({
      requirements: { oldRequirement: sent.oldRequirement, newRequirement: sent.newRequirement },
      output: {
        changeSummary: output.changeSummary,
        testCases: output.testCases.map(({ hoursBeforeStart, expectedAllowed, reason }) => ({
          hoursBeforeStart,
          expectedAllowed,
          reason,
        })),
      },
    }),
  );
}

/** Exact comparison: any edit, including whitespace, means the cases must be regenerated. */
export function generationMatchesDraft(record: GenerationRecord, draft: RequirementDraft): boolean {
  return (
    record.requirements.oldRequirement === draft.oldRequirement &&
    record.requirements.newRequirement === draft.newRequirement
  );
}

/** The executable fields only, exactly as sent to /api/run-tests. */
export function generatedExecutableCases(record: GenerationRecord): RegressionCase[] {
  return record.output.testCases.map(({ hoursBeforeStart, expectedAllowed }) => ({ hoursBeforeStart, expectedAllowed }));
}

export class StaleGenerationError extends Error {
  constructor() {
    super("The requirements changed after these cases were generated. Regenerate the tests before running them.");
    this.name = "StaleGenerationError";
  }
}

export interface GeneratedRunPayload {
  cases: RegressionCase[];
  /** The requirement text used for generation. Goes into the evidence snapshot. */
  requirements: RequirementDraft;
  aiContext: AiContext;
}

/** Everything needed to run generated cases. Refuses if the draft no longer matches the generation inputs. */
export function prepareGeneratedRun(record: GenerationRecord, draft: RequirementDraft): GeneratedRunPayload {
  if (!generationMatchesDraft(record, draft)) throw new StaleGenerationError();
  return {
    cases: generatedExecutableCases(record),
    requirements: { ...record.requirements },
    aiContext: {
      changeSummary: record.output.changeSummary,
      reasons: record.output.testCases.map((c) => c.reason),
    },
  };
}

export interface GenerationState {
  record: GenerationRecord | null;
  error: string | null;
  /** True when `error` came from a regeneration attempt while an earlier record was kept. */
  keptPrevious: boolean;
}

export const initialGenerationState: GenerationState = { record: null, error: null, keptPrevious: false };

export type GenerationOutcome = { ok: true; record: GenerationRecord } | { ok: false; error: string };

/**
 * Applies a generation result. Success replaces the record. Failure keeps any previous record
 * untouched, so earlier cases are neither replaced nor relabeled.
 */
export function applyGenerationOutcome(state: GenerationState, outcome: GenerationOutcome): GenerationState {
  if (outcome.ok) return { record: outcome.record, error: null, keptPrevious: false };
  return { record: state.record, error: outcome.error, keptPrevious: state.record !== null };
}

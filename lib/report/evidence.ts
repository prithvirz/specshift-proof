import { LEGACY_CANCELLATION_THRESHOLD_HOURS } from "@/lib/legacy/cancellation";
import type { CaseResult, RegressionCase, RunReport, RunSummary } from "@/lib/regression/types";
import { describeProposedRule, scenarioCases } from "@/lib/scenario/boundary";
import { PASS_FAIL_BASIS, SEEDED_TEXT_NOTE, describeExpectationSource } from "./expectation-source";

export type EvidenceSource = "seeded" | "ai" | "scenario";

/** The numeric rule chosen in the scenario editor. It defines expectations only, never actual results. */
export interface ScenarioContext {
  thresholdHours: number;
}

/** Display-only context from Gemini. Never used to decide pass/fail. */
export interface AiContext {
  changeSummary: string;
  /** Gemini's stated reason per case, aligned by index with `cases`. */
  reasons: string[];
}

/** An immutable record of one execution: what was sent, what the executor returned, and when. */
export interface EvidenceSnapshot {
  readonly executedAt: string;
  readonly source: EvidenceSource;
  readonly oldRequirement: string;
  readonly newRequirement: string;
  readonly cases: readonly Readonly<RegressionCase>[];
  readonly summary: Readonly<RunSummary>;
  readonly results: readonly Readonly<CaseResult>[];
  readonly aiContext?: Readonly<AiContext>;
  readonly scenario?: Readonly<ScenarioContext>;
}

export interface SnapshotInput {
  executedAt: Date;
  source: EvidenceSource;
  oldRequirement: string;
  newRequirement: string;
  /** Exactly the cases that were sent to the executor. */
  cases: readonly RegressionCase[];
  /** The executor's response for those cases. */
  report: RunReport;
  aiContext?: AiContext;
  scenario?: ScenarioContext;
}

export class EvidenceIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceIntegrityError";
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

/**
 * Checks that the executor output really corresponds to the submitted cases and is internally
 * consistent, so a report can never present results that do not belong to its inputs.
 */
function assertConsistent(cases: readonly RegressionCase[], report: RunReport): void {
  const { results, summary } = report;
  if (results.length !== cases.length) {
    throw new EvidenceIntegrityError("Result count does not match the submitted cases.");
  }
  results.forEach((r, i) => {
    const c = cases[i];
    if (r.hoursBeforeStart !== c.hoursBeforeStart || r.expectedAllowed !== c.expectedAllowed) {
      throw new EvidenceIntegrityError(`Result ${i + 1} does not match its submitted case.`);
    }
    const expectedStatus = r.actualAllowed === r.expectedAllowed ? "pass" : "fail";
    if (r.status !== expectedStatus) {
      throw new EvidenceIntegrityError(`Result ${i + 1} status is inconsistent with its values.`);
    }
  });
  const passed = results.filter((r) => r.status === "pass").length;
  if (summary.total !== results.length || summary.passed !== passed || summary.failed !== results.length - passed) {
    throw new EvidenceIntegrityError("Summary counts do not match the results.");
  }
}

/** Scenario evidence must contain exactly the boundary cases generated for its threshold. */
function assertScenarioCases(cases: readonly RegressionCase[], scenario: ScenarioContext): void {
  let expected: RegressionCase[];
  try {
    expected = scenarioCases(scenario.thresholdHours);
  } catch {
    throw new EvidenceIntegrityError("Scenario threshold is invalid.");
  }
  if (!sameCases(cases, expected)) {
    throw new EvidenceIntegrityError("Scenario cases do not match the boundary cases for the chosen threshold.");
  }
}

/** Builds a deep-copied, deep-frozen snapshot. Later edits to inputs cannot change it. */
export function createEvidenceSnapshot(input: SnapshotInput): EvidenceSnapshot {
  assertConsistent(input.cases, input.report);
  if (input.aiContext && input.source !== "ai") {
    throw new EvidenceIntegrityError("Gemini context is only allowed on Gemini-generated evidence.");
  }
  if (input.aiContext && input.aiContext.reasons.length !== input.cases.length) {
    throw new EvidenceIntegrityError("AI reasons must align with the submitted cases.");
  }
  if (input.source === "scenario") {
    if (!input.scenario) throw new EvidenceIntegrityError("Scenario evidence requires a threshold.");
    assertScenarioCases(input.cases, input.scenario);
  } else if (input.scenario) {
    throw new EvidenceIntegrityError("A scenario threshold is only allowed on scenario evidence.");
  }
  const snapshot: EvidenceSnapshot = structuredClone({
    executedAt: input.executedAt.toISOString(),
    source: input.source,
    oldRequirement: input.oldRequirement,
    newRequirement: input.newRequirement,
    cases: input.cases.map(({ hoursBeforeStart, expectedAllowed }) => ({ hoursBeforeStart, expectedAllowed })),
    summary: input.report.summary,
    results: input.report.results,
    ...(input.aiContext ? { aiContext: input.aiContext } : {}),
    ...(input.scenario ? { scenario: { thresholdHours: input.scenario.thresholdHours } } : {}),
  });
  return deepFreeze(snapshot);
}

export const describeBehavior = (allowed: boolean) => (allowed ? "Cancellation allowed" : "Cancellation blocked");

const hoursLabel = (h: number) => `${h} hour${h === 1 ? "" : "s"}`;

/** Deterministic mismatch explanation derived only from executed values and the legacy threshold. */
export function explainMismatch(result: CaseResult): string {
  const comparison =
    result.hoursBeforeStart >= LEGACY_CANCELLATION_THRESHOLD_HOURS ? "meets" : "is below";
  return (
    `The test expects cancellation to be ${result.expectedAllowed ? "allowed" : "blocked"} at ` +
    `${hoursLabel(result.hoursBeforeStart)} before start. The legacy canCancelBooking function ` +
    `(rule: hoursBeforeStart >= ${LEGACY_CANCELLATION_THRESHOLD_HOURS}) returned ` +
    `${result.actualAllowed}, because ${result.hoursBeforeStart} ${comparison} ` +
    `the ${LEGACY_CANCELLATION_THRESHOLD_HOURS}-hour threshold.`
  );
}

/**
 * Which way the legacy function disagrees with the expectation. Direction-neutral wording
 * that never names a particular requirement threshold.
 */
export function explainDirection(result: CaseResult): string {
  return result.expectedAllowed && !result.actualAllowed
    ? "The legacy rule is stricter here: it blocks a cancellation the test expects to be allowed."
    : "The legacy rule is more permissive here: it allows a cancellation the test expects to be blocked.";
}

export const failedResults = (s: EvidenceSnapshot) => s.results.filter((r) => r.status === "fail");
export const passedResults = (s: EvidenceSnapshot) => s.results.filter((r) => r.status === "pass");

export interface DraftState {
  oldRequirement: string;
  newRequirement: string;
  /** Executable fields of the currently displayed AI-generated cases, or null if none. */
  generatedCases: readonly RegressionCase[] | null;
  /** Current scenario-editor threshold, or null if the input is invalid. Only used for scenario evidence. */
  scenarioThreshold?: number | null;
}

export interface DraftDivergence {
  requirementsChanged: boolean;
  /**
   * AI evidence: the generated cases changed or were cleared.
   * Scenario evidence: the threshold changed or is invalid, so its cases would differ.
   * Always false for seeded evidence, whose cases are a fixed constant.
   */
  casesChanged: boolean;
  isStale: boolean;
}

const sameCases = (a: readonly RegressionCase[], b: readonly RegressionCase[]) =>
  a.length === b.length &&
  a.every((c, i) => c.hoursBeforeStart === b[i].hoursBeforeStart && c.expectedAllowed === b[i].expectedAllowed);

/** Compares the current draft with the snapshot so old evidence is never silently relabeled. */
export function compareWithDraft(snapshot: EvidenceSnapshot, draft: DraftState): DraftDivergence {
  const requirementsChanged =
    draft.oldRequirement !== snapshot.oldRequirement || draft.newRequirement !== snapshot.newRequirement;
  let casesChanged = false;
  if (snapshot.source === "ai") {
    casesChanged = draft.generatedCases === null || !sameCases(draft.generatedCases, snapshot.cases);
  } else if (snapshot.source === "scenario") {
    casesChanged = draft.scenarioThreshold !== snapshot.scenario?.thresholdHours;
  }
  return { requirementsChanged, casesChanged, isStale: requirementsChanged || casesChanged };
}

const SOURCE_LABELS: Record<EvidenceSource, string> = {
  seeded: "Seeded demo cases",
  ai: "Gemini-generated cases",
  scenario: "Scenario editor (deterministic boundary cases)",
};

export const sourceLabel = (source: EvidenceSource) => SOURCE_LABELS[source];

/** True when a scenario run found no mismatches. */
export const isScenarioNoRegression = (s: EvidenceSnapshot) => s.source === "scenario" && s.summary.failed === 0;

export const noRegressionMessage = (thresholdHours: number) =>
  `No regression detected for a ${thresholdHours}-hour threshold: the legacy function matched every expected outcome.`;

/** Escapes text for a single Markdown table cell. */
function cell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Renders text as a Markdown blockquote, preserving line breaks. */
function quote(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");
}

/** Readable Markdown report. Deterministic for a given snapshot. */
export function toMarkdown(snapshot: EvidenceSnapshot): string {
  const failed = failedResults(snapshot);
  const passed = passedResults(snapshot);
  const { summary } = snapshot;
  const expectations = describeExpectationSource(snapshot.source, snapshot.scenario);
  const lines: string[] = [
    "# SpecShift Proof: Regression Evidence Report",
    "",
    `- **Executed at:** ${snapshot.executedAt}`,
    `- **Test source:** ${sourceLabel(snapshot.source)}`,
    `- **Function under test:** \`canCancelBooking\` (legacy rule: \`hoursBeforeStart >= ${LEGACY_CANCELLATION_THRESHOLD_HOURS}\`)`,
    `- **Total:** ${summary.total} | **Passed:** ${summary.passed} | **Failed:** ${summary.failed}`,
    `- **Expected outcomes:** ${expectations.description}`,
    "",
    PASS_FAIL_BASIS,
    "",
    "## Requirements at execution time",
    "",
    "**Old requirement**",
    "",
    quote(snapshot.oldRequirement),
    "",
    "**New requirement**",
    "",
    quote(snapshot.newRequirement),
    "",
  ];

  if (snapshot.source === "seeded") lines.push(SEEDED_TEXT_NOTE, "");

  if (snapshot.scenario) {
    const t = snapshot.scenario.thresholdHours;
    lines.push(
      "## Proposed scenario rule (determines expected outcomes)",
      "",
      `- **Threshold:** ${t} hours`,
      `- **Rule:** ${describeProposedRule(t)}`,
      "",
      "Expected outcomes come from this numeric rule, set in the scenario editor. The written requirements above are recorded for context only and were not interpreted.",
      "",
    );
  }

  if (snapshot.aiContext) {
    lines.push(
      "## Gemini change summary (context only, not evidence)",
      "",
      quote(snapshot.aiContext.changeSummary),
      "",
    );
  }

  lines.push(`## Failed cases (${failed.length})`, "");
  if (failed.length === 0) {
    lines.push(snapshot.scenario ? noRegressionMessage(snapshot.scenario.thresholdHours) : "No failures.", "");
  } else {
    for (const r of failed) {
      lines.push(
        `### Case ${r.id}: hoursBeforeStart = ${r.hoursBeforeStart}`,
        "",
        `- **Input:** \`hoursBeforeStart = ${r.hoursBeforeStart}\``,
        `- **${expectations.expectedLabel}:** ${describeBehavior(r.expectedAllowed)} (\`${r.expectedAllowed}\`)`,
        `- **Actual:** ${describeBehavior(r.actualAllowed)} (\`${r.actualAllowed}\`)`,
        `- **Explanation:** ${explainMismatch(r)}`,
      );
      const reason = snapshot.aiContext?.reasons[r.id - 1];
      if (reason) lines.push(`- **Gemini's rationale for this case:** ${reason}`);
      lines.push("");
    }
  }

  lines.push(`## Passed cases (${passed.length})`, "");
  if (passed.length === 0) {
    lines.push("No passing cases.", "");
  } else {
    lines.push(`| Case | Input (hours) | ${cell(expectations.expectedLabel)} | Actual |`, "| --- | --- | --- | --- |");
    for (const r of passed) {
      lines.push(
        `| ${r.id} | ${r.hoursBeforeStart} | ${cell(describeBehavior(r.expectedAllowed))} | ${cell(describeBehavior(r.actualAllowed))} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

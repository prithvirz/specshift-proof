import { LEGACY_CANCELLATION_THRESHOLD_HOURS } from "@/lib/legacy/cancellation";
import type { CaseResult, RegressionCase, RunReport, RunSummary } from "@/lib/regression/types";

export type EvidenceSource = "seeded" | "ai";

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

/** Builds a deep-copied, deep-frozen snapshot. Later edits to inputs cannot change it. */
export function createEvidenceSnapshot(input: SnapshotInput): EvidenceSnapshot {
  assertConsistent(input.cases, input.report);
  if (input.aiContext && input.aiContext.reasons.length !== input.cases.length) {
    throw new EvidenceIntegrityError("AI reasons must align with the submitted cases.");
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

export const failedResults = (s: EvidenceSnapshot) => s.results.filter((r) => r.status === "fail");
export const passedResults = (s: EvidenceSnapshot) => s.results.filter((r) => r.status === "pass");

export interface DraftState {
  oldRequirement: string;
  newRequirement: string;
  /** Executable fields of the currently displayed AI-generated cases, or null if none. */
  generatedCases: readonly RegressionCase[] | null;
}

export interface DraftDivergence {
  requirementsChanged: boolean;
  /** Only meaningful for AI-sourced evidence; seeded cases are a fixed constant. */
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
  const casesChanged =
    snapshot.source === "ai" && (draft.generatedCases === null || !sameCases(draft.generatedCases, snapshot.cases));
  return { requirementsChanged, casesChanged, isStale: requirementsChanged || casesChanged };
}

export const sourceLabel = (source: EvidenceSource) =>
  source === "ai" ? "Gemini-generated cases" : "Seeded demo cases";

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
  const lines: string[] = [
    "# SpecShift Proof: Regression Evidence Report",
    "",
    `- **Executed at:** ${snapshot.executedAt}`,
    `- **Test source:** ${sourceLabel(snapshot.source)}`,
    `- **Function under test:** \`canCancelBooking\` (legacy rule: \`hoursBeforeStart >= ${LEGACY_CANCELLATION_THRESHOLD_HOURS}\`)`,
    `- **Total:** ${summary.total} | **Passed:** ${summary.passed} | **Failed:** ${summary.failed}`,
    "",
    "Pass/fail results come from executing the legacy function. They are not AI claims.",
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
    lines.push("No failures.", "");
  } else {
    for (const r of failed) {
      lines.push(
        `### Case ${r.id}: hoursBeforeStart = ${r.hoursBeforeStart}`,
        "",
        `- **Input:** \`hoursBeforeStart = ${r.hoursBeforeStart}\``,
        `- **Expected:** ${describeBehavior(r.expectedAllowed)} (\`${r.expectedAllowed}\`)`,
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
    lines.push("| Case | Input (hours) | Expected | Actual |", "| --- | --- | --- | --- |");
    for (const r of passed) {
      lines.push(
        `| ${r.id} | ${r.hoursBeforeStart} | ${cell(describeBehavior(r.expectedAllowed))} | ${cell(describeBehavior(r.actualAllowed))} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

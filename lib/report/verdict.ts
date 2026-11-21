import { isScenarioNoRegression, noRegressionMessage, type EvidenceSnapshot } from "./evidence";

export type VerdictTone = "regression" | "mismatch" | "pass";

export interface Verdict {
  tone: VerdictTone;
  title: string;
  /** "N of M test cases failed". */
  detail: string;
  /** Extra context, or null. */
  note: string | null;
  failed: number;
  total: number;
}

const countLine = (failed: number, total: number) =>
  `${failed} of ${total} test ${total === 1 ? "case" : "cases"} failed`;

/**
 * Verdict for a completed run, derived only from the executed snapshot's results.
 * Gemini runs never claim a confirmed regression, because their expectations are AI-proposed.
 */
export function describeVerdict(
  snapshot: Pick<EvidenceSnapshot, "source" | "results">,
): Verdict {
  // Count from the per-case results rather than trusting any stored summary.
  const total = snapshot.results.length;
  const failed = snapshot.results.filter((r) => r.status === "fail").length;
  const detail = countLine(failed, total);

  if (failed === 0) {
    return { tone: "pass", title: "All tests passed", detail, note: null, failed, total };
  }
  if (snapshot.source === "ai") {
    return {
      tone: "mismatch",
      title: "Mismatch detected",
      detail,
      note: "The legacy function disagrees with Gemini-proposed expectations. Review them before treating this as a regression.",
      failed,
      total,
    };
  }
  return { tone: "regression", title: "Regression detected", detail, note: null, failed, total };
}

/**
 * Whether the results should be scrolled to and focused: only when a new snapshot replaces
 * a different one, never on unrelated re-renders.
 */
export function shouldNavigateToResults(
  previous: EvidenceSnapshot | null,
  next: EvidenceSnapshot | null,
): boolean {
  return next !== null && next !== previous;
}

/**
 * The verdict to display. A passing scenario run adds the threshold-specific
 * "No regression detected" message as the verdict note, so only one green banner is shown.
 */
export function verdictForDisplay(snapshot: EvidenceSnapshot): Verdict {
  const verdict = describeVerdict(snapshot);
  if (snapshot.scenario && isScenarioNoRegression(snapshot)) {
    return { ...verdict, note: noRegressionMessage(snapshot.scenario.thresholdHours) };
  }
  return verdict;
}
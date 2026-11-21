import { canCancelBooking } from "@/lib/legacy/cancellation";
import type { CaseResult, RegressionCase, RunReport } from "./types";

function describeAllowed(allowed: boolean): string {
  return allowed ? "allowed" : "blocked";
}

function formatHours(hours: number): string {
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/**
 * Runs each case against the real legacy `canCancelBooking` function
 * and compares actual vs. expected. Results are never fabricated.
 */
export function runRegressionCases(
  cases: readonly RegressionCase[],
  fn: (hoursBeforeStart: number) => boolean = canCancelBooking,
): RunReport {
  const results: CaseResult[] = cases.map((testCase, index) => {
    const actualAllowed = fn(testCase.hoursBeforeStart);
    const passed = actualAllowed === testCase.expectedAllowed;
    const hours = formatHours(testCase.hoursBeforeStart);

    const explanation = passed
      ? `With ${hours} before start, cancellation is ${describeAllowed(actualAllowed)}, as expected.`
      : `With ${hours} before start, the test expects cancellation to be ${describeAllowed(testCase.expectedAllowed)}, but the legacy function returned ${describeAllowed(actualAllowed)}.`;

    return {
      id: index + 1,
      hoursBeforeStart: testCase.hoursBeforeStart,
      expectedAllowed: testCase.expectedAllowed,
      actualAllowed,
      status: passed ? "pass" : "fail",
      explanation,
    };
  });

  const passed = results.filter((r) => r.status === "pass").length;
  return {
    summary: { total: results.length, passed, failed: results.length - passed },
    results,
  };
}

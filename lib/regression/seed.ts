import type { RegressionCase } from "./types";

export const OLD_REQUIREMENT =
  "Customers may cancel their booking if at least 24 hours remain before the booking starts.";

export const NEW_REQUIREMENT =
  "Customers may cancel their booking if at least 2 hours remain before the booking starts.";

/** Regression cases derived (by hand) from the NEW requirement. */
export const SEED_CASES: readonly RegressionCase[] = [
  { hoursBeforeStart: 1, expectedAllowed: false },
  { hoursBeforeStart: 3, expectedAllowed: true },
  { hoursBeforeStart: 25, expectedAllowed: true },
];

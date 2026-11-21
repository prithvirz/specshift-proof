import { z } from "zod";
import { LEGACY_CANCELLATION_THRESHOLD_HOURS } from "@/lib/legacy/cancellation";
import type { RegressionCase } from "@/lib/regression/types";

export const MIN_SCENARIO_THRESHOLD = 0;
export const MAX_SCENARIO_THRESHOLD = 168;
export const DEFAULT_SCENARIO_THRESHOLD = 2;

/** Proposed threshold in whole hours. Never derived from requirement text. */
export const scenarioThresholdSchema = z
  .number({ error: "Enter a number of hours." })
  .int("Use a whole number of hours.")
  .min(MIN_SCENARIO_THRESHOLD, `Minimum is ${MIN_SCENARIO_THRESHOLD} hours.`)
  .max(MAX_SCENARIO_THRESHOLD, `Maximum is ${MAX_SCENARIO_THRESHOLD} hours.`);

/** The proposed scenario rule. Used only to state expectations, never to produce actual results. */
export const proposedRuleAllows = (hoursBeforeStart: number, thresholdHours: number) =>
  hoursBeforeStart >= thresholdHours;

export interface BoundaryCase extends RegressionCase {
  /** Why the input is included. Display only. */
  notes: string[];
}

/**
 * Deterministic boundary cases for the rule "allowed iff hoursBeforeStart >= T".
 * Inputs: 0, T-1, T, T+1, the legacy boundary (23, 24), and one value well past both thresholds.
 * Negative values are dropped, duplicates merged, and the result is sorted ascending.
 */
export function generateBoundaryCases(thresholdHours: number): BoundaryCase[] {
  const parsed = scenarioThresholdSchema.safeParse(thresholdHours);
  if (!parsed.success) {
    throw new RangeError(`Invalid scenario threshold: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }
  const t = parsed.data;
  const legacy = LEGACY_CANCELLATION_THRESHOLD_HOURS;
  const candidates: Array<[number, string]> = [
    [0, "Booking starting now"],
    [t - 1, "Just below the proposed threshold"],
    [t, "Exactly at the proposed threshold"],
    [t + 1, "Just above the proposed threshold"],
    [legacy - 1, "Just below the legacy 24-hour threshold"],
    [legacy, "Exactly at the legacy 24-hour threshold"],
    [Math.max(t, legacy) + 24, "Well beyond both thresholds"],
  ];

  const byHours = new Map<number, string[]>();
  for (const [hours, note] of candidates) {
    if (hours < 0) continue;
    const notes = byHours.get(hours) ?? [];
    notes.push(note);
    byHours.set(hours, notes);
  }

  return [...byHours.entries()]
    .sort(([a], [b]) => a - b)
    .map(([hoursBeforeStart, notes]) => ({
      hoursBeforeStart,
      expectedAllowed: proposedRuleAllows(hoursBeforeStart, t),
      notes,
    }));
}

/** The executable part of the boundary cases, exactly as sent to /api/run-tests. */
export function scenarioCases(thresholdHours: number): RegressionCase[] {
  return generateBoundaryCases(thresholdHours).map(({ hoursBeforeStart, expectedAllowed }) => ({
    hoursBeforeStart,
    expectedAllowed,
  }));
}

export const describeProposedRule = (thresholdHours: number) =>
  `Cancellation allowed if hoursBeforeStart >= ${thresholdHours}`;

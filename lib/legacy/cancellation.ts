/**
 * LEGACY business rule (OLD requirement):
 * "Customers may cancel their booking if at least 24 hours remain before the booking starts."
 *
 * This intentionally does NOT implement the new 2-hour requirement.
 * The mismatch is the point of the demo. Do not "fix" it.
 */
export const LEGACY_CANCELLATION_THRESHOLD_HOURS = 24;

export function canCancelBooking(hoursBeforeStart: number): boolean {
  return hoursBeforeStart >= LEGACY_CANCELLATION_THRESHOLD_HOURS;
}

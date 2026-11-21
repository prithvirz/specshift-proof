import { describe, expect, it } from "vitest";
import { canCancelBooking } from "@/lib/legacy/cancellation";

describe("canCancelBooking (legacy 24h rule)", () => {
  it.each([
    [0, false],
    [1, false],
    [2, false],
    [3, false],
    [23.99, false],
    [24, true],
    [25, true],
    [10000, true],
  ])("hours=%s -> %s", (hours, expected) => {
    expect(canCancelBooking(hours)).toBe(expected);
  });
});

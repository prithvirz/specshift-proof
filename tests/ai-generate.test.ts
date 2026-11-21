import { describe, expect, it, vi } from "vitest";
import { InvalidModelOutputError, generateTestCases } from "@/lib/ai/generate";
import type { TestCaseProvider } from "@/lib/ai/provider";
import { generateTestsRequestSchema } from "@/lib/ai/schema";
import { runRegressionCases } from "@/lib/regression/executor";
import { runTestsRequestSchema } from "@/lib/regression/schema";
import { NEW_REQUIREMENT, OLD_REQUIREMENT } from "@/lib/regression/seed";

const input = { oldRequirement: OLD_REQUIREMENT, newRequirement: NEW_REQUIREMENT };

const validOutput = {
  changeSummary: "The cancellation window shrinks from 24 hours to 2 hours.",
  testCases: [
    { hoursBeforeStart: 1, expectedAllowed: false, reason: "Below the new threshold." },
    { hoursBeforeStart: 2, expectedAllowed: true, reason: "Exactly at the new threshold." },
    { hoursBeforeStart: 3, expectedAllowed: true, reason: "Newly allowed under the new rule." },
    { hoursBeforeStart: 23.5, expectedAllowed: true, reason: "Previously blocked, now allowed." },
    { hoursBeforeStart: 24, expectedAllowed: true, reason: "Old threshold stays allowed." },
    { hoursBeforeStart: 48, expectedAllowed: true, reason: "Unchanged behavior far ahead." },
  ],
};

const providerReturning = (text: string): TestCaseProvider => ({ generateJson: vi.fn(async () => text) });

describe("generateTestsRequestSchema", () => {
  it("accepts valid input", () => {
    expect(generateTestsRequestSchema.safeParse(input).success).toBe(true);
  });
  it("rejects empty, whitespace-only, missing, and oversized requirements", () => {
    expect(generateTestsRequestSchema.safeParse({ ...input, oldRequirement: "" }).success).toBe(false);
    expect(generateTestsRequestSchema.safeParse({ ...input, newRequirement: "   " }).success).toBe(false);
    expect(generateTestsRequestSchema.safeParse({ oldRequirement: "x" }).success).toBe(false);
    expect(generateTestsRequestSchema.safeParse({ ...input, oldRequirement: "a".repeat(3001) }).success).toBe(false);
    expect(generateTestsRequestSchema.safeParse({ ...input, oldRequirement: "a".repeat(3000) }).success).toBe(true);
  });
});

describe("generateTestCases", () => {
  it("returns validated cases from a valid model response", async () => {
    const provider = providerReturning(JSON.stringify(validOutput));
    const result = await generateTestCases(input, provider);
    expect(result).toEqual(validOutput);
    expect(provider.generateJson).toHaveBeenCalledTimes(1);
  });

  it("sends both requirements to the provider", async () => {
    const provider = providerReturning(JSON.stringify(validOutput));
    await generateTestCases(input, provider);
    const [, prompt] = vi.mocked(provider.generateJson).mock.calls[0];
    expect(prompt).toContain(OLD_REQUIREMENT);
    expect(prompt).toContain(NEW_REQUIREMENT);
  });

  const bad: Array<[string, unknown]> = [
    ["fewer than 5 cases", { ...validOutput, testCases: validOutput.testCases.slice(0, 4) }],
    ["more than 8 cases", { ...validOutput, testCases: [...validOutput.testCases, ...[30, 40, 50].map((h) => ({ hoursBeforeStart: h, expectedAllowed: true, reason: "x" }))] }],
    ["negative hours", { ...validOutput, testCases: [{ ...validOutput.testCases[0], hoursBeforeStart: -1 }, ...validOutput.testCases.slice(1)] }],
    ["hours above 10000", { ...validOutput, testCases: [{ ...validOutput.testCases[0], hoursBeforeStart: 10001 }, ...validOutput.testCases.slice(1)] }],
    ["non-boolean expectedAllowed", { ...validOutput, testCases: [{ ...validOutput.testCases[0], expectedAllowed: "yes" }, ...validOutput.testCases.slice(1)] }],
    ["missing reason", { ...validOutput, testCases: [{ hoursBeforeStart: 1, expectedAllowed: false }, ...validOutput.testCases.slice(1)] }],
    ["missing changeSummary", { testCases: validOutput.testCases }],
    ["duplicate hours", { ...validOutput, testCases: [...validOutput.testCases.slice(0, 5), validOutput.testCases[0]] }],
  ];
  it.each(bad)("rejects model output with %s", async (_name, payload) => {
    await expect(generateTestCases(input, providerReturning(JSON.stringify(payload)))).rejects.toBeInstanceOf(
      InvalidModelOutputError,
    );
  });

  it("rejects non-JSON model output", async () => {
    await expect(generateTestCases(input, providerReturning("not json"))).rejects.toBeInstanceOf(
      InvalidModelOutputError,
    );
  });

  it("propagates provider errors unchanged", async () => {
    const provider: TestCaseProvider = { generateJson: vi.fn().mockRejectedValue(new Error("boom")) };
    await expect(generateTestCases(input, provider)).rejects.toThrow("boom");
  });
});

describe("generated cases and the deterministic executor", () => {
  it("are accepted by the /api/run-tests schema once reason is dropped", async () => {
    const generated = await generateTestCases(input, providerReturning(JSON.stringify(validOutput)));
    const cases = generated.testCases.map(({ hoursBeforeStart, expectedAllowed }) => ({ hoursBeforeStart, expectedAllowed }));
    expect(runTestsRequestSchema.safeParse({ cases }).success).toBe(true);
  });

  it("get pass/fail only from the real legacy function (24h rule)", async () => {
    const generated = await generateTestCases(input, providerReturning(JSON.stringify(validOutput)));
    const report = runRegressionCases(generated.testCases);
    // Legacy rule blocks 1, 2, 3, 23.5 hours; allows 24 and 48.
    expect(report.results.map((r) => r.actualAllowed)).toEqual([false, false, false, false, true, true]);
    expect(report.results.map((r) => r.status)).toEqual(["pass", "fail", "fail", "fail", "pass", "pass"]);
    expect(report.summary).toEqual({ total: 6, passed: 3, failed: 3 });
  });
});

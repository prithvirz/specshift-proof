import { z } from "zod";
import { regressionCaseSchema } from "@/lib/regression/schema";

export const MAX_REQUIREMENT_LENGTH = 3000;
export const MIN_GENERATED_CASES = 5;
export const MAX_GENERATED_CASES = 8;

const requirementSchema = z
  .string()
  .trim()
  .min(1, "Requirement must not be empty.")
  .max(MAX_REQUIREMENT_LENGTH, `Requirement must be at most ${MAX_REQUIREMENT_LENGTH} characters.`);

export const generateTestsRequestSchema = z.object({
  oldRequirement: requirementSchema,
  newRequirement: requirementSchema,
});

/** Reuses the /api/run-tests case schema so generated cases stay executable. */
export const generatedCaseSchema = regressionCaseSchema.extend({
  reason: z.string().trim().min(1).max(500),
});

export const generatedOutputSchema = z
  .object({
    changeSummary: z.string().trim().min(1).max(1500),
    testCases: z.array(generatedCaseSchema).min(MIN_GENERATED_CASES).max(MAX_GENERATED_CASES),
  })
  .refine((v) => new Set(v.testCases.map((c) => c.hoursBeforeStart)).size === v.testCases.length, {
    message: "Duplicate hoursBeforeStart values are not allowed.",
    path: ["testCases"],
  });

export type GenerateTestsRequest = z.infer<typeof generateTestsRequestSchema>;
export type GeneratedCase = z.infer<typeof generatedCaseSchema>;
export type GeneratedTests = z.infer<typeof generatedOutputSchema>;

/** JSON Schema sent to Gemini to steer structured output. Zod remains the source of truth. */
export const geminiResponseJsonSchema = {
  type: "object",
  properties: {
    changeSummary: { type: "string" },
    testCases: {
      type: "array",
      minItems: MIN_GENERATED_CASES,
      maxItems: MAX_GENERATED_CASES,
      items: {
        type: "object",
        properties: {
          hoursBeforeStart: { type: "number" },
          expectedAllowed: { type: "boolean" },
          reason: { type: "string" },
        },
        required: ["hoursBeforeStart", "expectedAllowed", "reason"],
      },
    },
  },
  required: ["changeSummary", "testCases"],
} as const;

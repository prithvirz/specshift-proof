import { z } from "zod";

export const MAX_CASES = 20;
export const MAX_HOURS = 10000;

export const regressionCaseSchema = z.object({
  hoursBeforeStart: z.number().finite().min(0).max(MAX_HOURS),
  expectedAllowed: z.boolean(),
});

export const runTestsRequestSchema = z.object({
  cases: z.array(regressionCaseSchema).min(1).max(MAX_CASES),
});

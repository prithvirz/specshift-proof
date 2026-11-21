export interface RegressionCase {
  hoursBeforeStart: number;
  expectedAllowed: boolean;
}

export type CaseStatus = "pass" | "fail";

export interface CaseResult {
  id: number;
  hoursBeforeStart: number;
  expectedAllowed: boolean;
  actualAllowed: boolean;
  status: CaseStatus;
  explanation: string;
}

export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
}

export interface RunReport {
  summary: RunSummary;
  results: CaseResult[];
}

"use client";

import { useMemo, useState } from "react";
import { Loader2, Play, ShieldCheck, Info, AlertCircle, Sparkles, FileText, History, CheckCircle2 } from "lucide-react";
import { ScenarioEditor } from "@/components/scenario-editor";
import { EvidenceReport } from "@/components/evidence-report";
import { GeneratedPreview } from "@/components/generated-preview";
import { FailureExplanation } from "@/components/failure-explanation";
import { ResultCard } from "@/components/result-card";
import { SummaryBar } from "@/components/summary-bar";
import { NEW_REQUIREMENT, OLD_REQUIREMENT, SEED_CASES } from "@/lib/regression/seed";
import type { GeneratedTests } from "@/lib/ai/schema";
import { ACCESS_CODE_HEADER } from "@/lib/ai/access-header";
import {
  NETWORK_ERROR_MESSAGE,
  describeGenerationFailure,
  isNetworkError,
  readFailedResponse,
} from "@/lib/ai/client-errors";
import {
  applyGenerationOutcome,
  createGenerationRecord,
  generatedExecutableCases,
  generationMatchesDraft,
  initialGenerationState,
  prepareGeneratedRun,
  type GenerationState,
  type RequirementDraft,
} from "@/lib/ai/generation-record";
import type { RegressionCase, RunReport } from "@/lib/regression/types";
import {
  compareWithDraft,
  createEvidenceSnapshot,
  isScenarioNoRegression,
  noRegressionMessage,
  sourceLabel,
  type AiContext,
  type EvidenceSnapshot,
  type EvidenceSource,
  type ScenarioContext,
} from "@/lib/report/evidence";
import {
  DEFAULT_SCENARIO_THRESHOLD,
  generateBoundaryCases,
  scenarioThresholdSchema,
} from "@/lib/scenario/boundary";

function parseThreshold(raw: string): { value: number | null; error: string | null } {
  if (raw.trim() === "") return { value: null, error: "Enter a number of hours." };
  const parsed = scenarioThresholdSchema.safeParse(Number(raw));
  return parsed.success
    ? { value: parsed.data, error: null }
    : { value: null, error: parsed.error.issues[0]?.message ?? "Invalid threshold." };
}

async function readError(res: Response): Promise<string> {
  const data: unknown = await res.json().catch(() => null);
  if (data && typeof data === "object" && "error" in data && typeof data.error === "string") {
    return data.error;
  }
  return `Request failed with status ${res.status}.`;
}

/** Thrown for failures that already have a user-facing message. */
class UserFacingError extends Error {}

/** Runs fetch and turns "never reached the server" failures into a clear message. */
async function fetchOrExplain(input: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (e) {
    if (isNetworkError(e)) throw new UserFacingError(NETWORK_ERROR_MESSAGE);
    throw e;
  }
}

export function Dashboard() {
  const [oldReq, setOldReq] = useState(OLD_REQUIREMENT);
  const [newReq, setNewReq] = useState(NEW_REQUIREMENT);
  const [snapshot, setSnapshot] = useState<EvidenceSnapshot | null>(null);
  const [showEvidence, setShowEvidence] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runningFrom, setRunningFrom] = useState<EvidenceSource | null>(null);
  const [generation, setGeneration] = useState<GenerationState>(initialGenerationState);
  const [generating, setGenerating] = useState(false);
  // Held in component memory only: never persisted, put in a URL, or added to evidence.
  const [accessCode, setAccessCode] = useState("");
  const generated = generation.record;
  const generationIsCurrent = generated
    ? generationMatchesDraft(generated, { oldRequirement: oldReq, newRequirement: newReq })
    : false;
  const [rawThreshold, setRawThreshold] = useState(String(DEFAULT_SCENARIO_THRESHOLD));
  const threshold = useMemo(() => parseThreshold(rawThreshold), [rawThreshold]);
  const boundaryCases = useMemo(
    () => (threshold.value === null ? [] : generateBoundaryCases(threshold.value)),
    [threshold.value],
  );

  async function run(
    cases: readonly RegressionCase[],
    from: EvidenceSource,
    context: { aiContext?: AiContext; scenario?: ScenarioContext; requirements?: RequirementDraft } = {},
  ) {
    // Capture inputs at click time so later edits cannot leak into this run's evidence.
    // AI runs pass the requirement text that was used for generation.
    const requirements = context.requirements ?? { oldRequirement: oldReq, newRequirement: newReq };
    const captured = { ...requirements, cases: cases.map((c) => ({ ...c })) };
    setLoading(true);
    setRunningFrom(from);
    setError(null);
    try {
      const res = await fetchOrExplain("/api/run-tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cases }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const report = (await res.json()) as RunReport;
      setSnapshot(
        createEvidenceSnapshot({
          executedAt: new Date(),
          source: from,
          oldRequirement: captured.oldRequirement,
          newRequirement: captured.newRequirement,
          cases: captured.cases,
          report,
          aiContext: context.aiContext,
          scenario: context.scenario,
        }),
      );
    } catch (e) {
      setSnapshot(null);
      setError(e instanceof Error ? e.message : "Unexpected error running tests.");
    } finally {
      setLoading(false);
      setRunningFrom(null);
    }
  }

  async function generate() {
    // Capture the exact text sent, so the record matches what Gemini saw even if the user keeps typing.
    const sent: RequirementDraft = { oldRequirement: oldReq, newRequirement: newReq };
    setGenerating(true);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const code = accessCode.trim();
      if (code) headers[ACCESS_CODE_HEADER] = code;
      const res = await fetchOrExplain("/api/generate-tests", {
        method: "POST",
        headers,
        body: JSON.stringify(sent),
      });
      if (!res.ok) throw new UserFacingError(describeGenerationFailure(await readFailedResponse(res)));
      const record = createGenerationRecord(sent, (await res.json()) as GeneratedTests);
      setGeneration((s) => applyGenerationOutcome(s, { ok: true, record }));
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unexpected error generating tests.";
      setGeneration((s) => applyGenerationOutcome(s, { ok: false, error: message }));
    } finally {
      setGenerating(false);
    }
  }

  function runGenerated() {
    if (!generated || !generationIsCurrent) return;
    // Refuses (throws) if the draft no longer matches the generation inputs.
    const payload = prepareGeneratedRun(generated, { oldRequirement: oldReq, newRequirement: newReq });
    void run(payload.cases, "ai", { aiContext: payload.aiContext, requirements: payload.requirements });
  }

  function runScenario() {
    if (threshold.value === null) return;
    const thresholdHours = threshold.value;
    // Send only the executable fields; `notes` are display-only.
    void run(
      generateBoundaryCases(thresholdHours).map(({ hoursBeforeStart, expectedAllowed }) => ({
        hoursBeforeStart,
        expectedAllowed,
      })),
      "scenario",
      { scenario: { thresholdHours } },
    );
  }

  const divergence = useMemo(
    () =>
      snapshot
        ? compareWithDraft(snapshot, {
            oldRequirement: oldReq,
            newRequirement: newReq,
            generatedCases: generated ? generatedExecutableCases(generated) : null,
            scenarioThreshold: threshold.value,
          })
        : null,
    [snapshot, oldReq, newReq, generated, threshold.value],
  );
  const failures = snapshot?.results.filter((r) => r.status === "fail") ?? [];
  const areaClass =
    "mt-1 w-full rounded-lg border border-slate-300 bg-white p-3 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200";

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-indigo-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-4">
          <ShieldCheck className="size-8 text-indigo-600" />
          <div>
            <h1 className="text-xl font-bold">SpecShift Proof</h1>
            <p className="text-sm text-slate-500">Detect behavioral regressions caused by requirement changes</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-4 py-8">
        <div className="flex gap-2 rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
          <Info className="mt-0.5 size-4 shrink-0" />
          <p>
            Scope: this MVP supports only the controlled booking-cancellation scenario. AI can propose
            test cases from the requirement text, but nothing generates or executes code, and arbitrary requirements
            cannot be run. Editing the text never changes business logic. Every pass/fail comes from the real legacy
            <code className="mx-1 rounded bg-sky-100 px-1">canCancelBooking</code> function, which implements the
            old 24-hour rule.
          </p>
        </div>

        <section className="grid gap-4 md:grid-cols-2">
          <label className="block text-sm font-semibold">
            Old requirement
            <textarea className={areaClass} rows={4} value={oldReq} onChange={(e) => setOldReq(e.target.value)} />
          </label>
          <label className="block text-sm font-semibold">
            New requirement
            <textarea className={areaClass} rows={4} value={newReq} onChange={(e) => setNewReq(e.target.value)} />
          </label>
        </section>

        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => void run(SEED_CASES, "seeded")}
            disabled={loading || generating}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2.5 font-semibold text-white shadow hover:bg-indigo-700 disabled:opacity-60"
          >
            {runningFrom === "seeded" ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            Run Regression Tests
          </button>
          <button
            onClick={() => void generate()}
            disabled={loading || generating}
            className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-5 py-2.5 font-semibold text-white shadow hover:bg-violet-700 disabled:opacity-60"
          >
            {generating ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            {generating ? "Generating..." : "Generate Tests with AI"}
          </button>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block text-sm font-semibold text-slate-900">
            Demo access code (for AI generation)
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={accessCode}
              onChange={(e) => setAccessCode(e.target.value)}
              placeholder="Required for Generate Tests with AI"
              className="mt-1 block w-72 max-w-full rounded-lg border border-slate-300 bg-white p-2 text-sm font-normal text-slate-900 focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-200"
            />
          </label>
        </div>
        <p className="text-xs text-slate-500">
          &quot;Run Regression Tests&quot; and the scenario editor work without an access code or API key. AI generation
          must be enabled on the server and needs the demo access code. The code is kept in this page only and is not
          saved.
        </p>

        {generation.error && (
          <div role="alert" className="flex gap-2 rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <p>
              {generation.error}
              {generation.keptPrevious && (
                <> No new cases were generated. The cases below are from the previous successful generation.</>
              )}
            </p>
          </div>
        )}

        {generated && (
          <div className="space-y-3">
            <GeneratedPreview generated={generated.output} />
            {!generationIsCurrent && (
              <div className="flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" role="status">
                <History className="mt-0.5 size-4 shrink-0" />
                <p>
                  <strong>These cases are out of date.</strong> The requirement text has been edited since these cases
                  were generated, so they may not match it. Click &quot;Generate Tests with AI&quot; to regenerate
                  before running.
                </p>
              </div>
            )}
            <button
              onClick={runGenerated}
              disabled={loading || generating || !generationIsCurrent}
              title={generationIsCurrent ? undefined : "Regenerate the tests: the requirements changed"}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 font-semibold text-white shadow hover:bg-emerald-700 disabled:opacity-60"
            >
              {runningFrom === "ai" ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
              {runningFrom === "ai" ? "Running..." : "Run Generated Tests"}
            </button>
          </div>
        )}

        <ScenarioEditor
          rawThreshold={rawThreshold}
          onThresholdChange={setRawThreshold}
          threshold={threshold.value}
          validationError={threshold.error}
          cases={boundaryCases}
          onRun={runScenario}
          disabled={loading || generating}
          running={runningFrom === "scenario"}
        />

        {error && (
          <div role="alert" className="flex gap-2 rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <p>{error}</p>
          </div>
        )}

        {snapshot && (
          <section className="space-y-4" aria-live="polite">
            <p className="text-sm font-semibold text-slate-700">
              Results for {sourceLabel(snapshot.source)}
              {snapshot.scenario ? ` (proposed threshold: ${snapshot.scenario.thresholdHours} hours)` : ""}, executed by
              the legacy function
            </p>
            {divergence?.isStale && (
              <div className="flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" role="status">
                <History className="mt-0.5 size-4 shrink-0" />
                <p>
                  <strong>Previous execution evidence.</strong>{" "}
                  {[
                    divergence.requirementsChanged && "The requirement text has been edited",
                    divergence.casesChanged &&
                      (snapshot.source === "scenario"
                        ? "the scenario threshold has changed"
                        : "the generated cases have changed"),
                  ]
                    .filter(Boolean)
                    .join(" and ")}{" "}
                  since these tests ran. These results reflect the inputs captured in the evidence report, not the
                  current draft. Run the tests again to produce new evidence.
                </p>
              </div>
            )}
            <SummaryBar summary={snapshot.summary} />
            {isScenarioNoRegression(snapshot) && snapshot.scenario && (
              <div className="flex gap-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900" role="status">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
                <p className="font-semibold">{noRegressionMessage(snapshot.scenario.thresholdHours)}</p>
              </div>
            )}
            <FailureExplanation failures={failures} />
            <ul className="grid gap-3">
              {snapshot.results.map((r) => (
                <ResultCard key={r.id} result={r} />
              ))}
            </ul>

            <div className="space-y-3 border-t border-slate-200 pt-4">
              <button
                onClick={() => setShowEvidence((v) => !v)}
                aria-expanded={showEvidence}
                className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-5 py-2.5 font-semibold text-white shadow hover:bg-slate-800"
              >
                <FileText className="size-4" />
                {showEvidence ? "Hide Evidence Report" : "View Evidence Report"}
              </button>
              {showEvidence && <EvidenceReport snapshot={snapshot} isStale={divergence?.isStale ?? false} />}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}




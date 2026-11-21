"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { VerdictBanner } from "@/components/verdict-banner";
import { shouldNavigateToResults, verdictForDisplay } from "@/lib/report/verdict";
import { describeExpectationSource, requirementsDifferFromSeedDefaults } from "@/lib/report/expectation-source";
import { Loader2, Play, ShieldCheck, Info, AlertCircle, Sparkles, FileText, History } from "lucide-react";
import { LEGACY_CANCELLATION_THRESHOLD_HOURS } from "@/lib/legacy/cancellation";
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

/** Run-error alert, rendered next to the button that started the run. */
function RunError({ message }: { message: string }) {
  return (
    <div role="alert" className="flex gap-2 rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <p>{message}</p>
    </div>
  );
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
  // The run error and which button started that run, so the error appears next to it.
  const [runError, setRunError] = useState<{ from: EvidenceSource; message: string } | null>(null);
  const resultsHeadingRef = useRef<HTMLHeadingElement>(null);
  const navigatedSnapshotRef = useRef<EvidenceSnapshot | null>(null);
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
    setRunError(null);
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
      setRunError({ from, message: e instanceof Error ? e.message : "Unexpected error running tests." });
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
  // Scroll to and focus the results only when a new snapshot arrives, never on unrelated state changes.
  useEffect(() => {
    if (!shouldNavigateToResults(navigatedSnapshotRef.current, snapshot)) return;
    navigatedSnapshotRef.current = snapshot;
    const heading = resultsHeadingRef.current;
    if (!heading) return;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    heading.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    heading.focus({ preventScroll: true });
  }, [snapshot]);

  const failures = snapshot?.results.filter((r) => r.status === "fail") ?? [];
  // A passing scenario run gets one combined green banner instead of two.
  const verdictToShow = snapshot ? verdictForDisplay(snapshot) : null;
  const expectations = snapshot ? describeExpectationSource(snapshot.source, snapshot.scenario) : null;
  const seededTextEdited = requirementsDifferFromSeedDefaults({ oldRequirement: oldReq, newRequirement: newReq });
  const busy = loading || generating;
  const areaClass =
    "mt-1 w-full rounded-lg border border-slate-300 bg-white p-3 text-sm font-normal text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200";

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-indigo-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center gap-2 px-4 py-3">
          <ShieldCheck className="size-6 text-indigo-600" aria-hidden="true" />
          <p className="font-bold tracking-tight">SpecShift Proof</p>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-8 px-4 py-8 sm:py-10">
        {/* 30-second story */}
        <section className="space-y-6" aria-labelledby="hero-heading">
          <div className="space-y-3">
            <h1 id="hero-heading" className="text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">
              Requirements changed. Did your code?
            </h1>
            <p className="max-w-3xl text-base text-slate-600 sm:text-lg">
              SpecShift Proof runs real tests against existing code and highlights where its behavior no longer matches
              a changed requirement.
            </p>
          </div>

          <ol className="grid gap-3 sm:grid-cols-3">
            <li className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-indigo-600">1 · Requirement changed</p>
              <p className="mt-2 text-2xl font-bold text-slate-900">24 h → 2 h</p>
              <p className="mt-1 text-sm text-slate-600">
                Customers may now cancel up to 2 hours before a booking starts, instead of 24.
              </p>
            </li>
            <li className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-600">2 · Code still says 24 h</p>
              <p className="mt-2 break-words font-mono text-lg font-bold text-slate-900">
                hours &gt;= {LEGACY_CANCELLATION_THRESHOLD_HOURS}
              </p>
              <p className="mt-1 text-sm text-slate-600">
                The legacy <code className="rounded bg-slate-100 px-1">canCancelBooking</code> function was never
                updated.
              </p>
            </li>
            <li className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-rose-600">3 · SpecShift shows the gap</p>
              <p className="mt-2 text-2xl font-bold text-slate-900">Real tests</p>
              <p className="mt-1 text-sm text-slate-600">
                It runs test cases against the actual function and highlights every mismatch.
              </p>
            </li>
          </ol>

          <div className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
              <button
                onClick={() => void run(SEED_CASES, "seeded")}
                disabled={busy}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-7 py-3.5 text-lg font-bold text-white shadow-md hover:bg-indigo-700 focus:outline-none focus-visible:ring-4 focus-visible:ring-indigo-300 disabled:opacity-60 sm:w-auto"
              >
                {runningFrom === "seeded" ? (
                  <Loader2 className="size-5 animate-spin" />
                ) : (
                  <Play className="size-5" />
                )}
                {runningFrom === "seeded" ? "Running..." : "Run Demo Tests"}
              </button>
              <p className="text-sm text-slate-500">3 fixed demo cases. No API key or access code needed.</p>
            </div>
            {runError?.from === "seeded" && <RunError message={runError.message} />}
            {seededTextEdited && (
              <p
                className="flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900"
                role="status"
              >
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  The requirement text differs from the seeded demo. &quot;Run Demo Tests&quot; still uses the fixed
                  seeded cases, which were written for the original text and do not update automatically.
                </span>
              </p>
            )}
          </div>

          <p className="flex gap-2 text-xs text-slate-500">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>
              Demo scope: one controlled booking-cancellation rule. SpecShift does not analyze arbitrary repositories
              or change code. Actual outcomes always come from running the real legacy function, and pass/fail compares
              them with each test&apos;s expected outcome.
            </span>
          </p>
        </section>

        {/* Requirement text */}
        <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5" aria-labelledby="requirements-heading">
          <div>
            <h2 id="requirements-heading" className="font-semibold text-slate-900">
              Requirement text
            </h2>
            <p className="text-sm text-slate-600">
              Sent to Gemini for AI generation and recorded in each evidence report. Editing it never changes the code.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block text-sm font-semibold text-slate-800">
              Old requirement
              <textarea className={areaClass} rows={3} value={oldReq} onChange={(e) => setOldReq(e.target.value)} />
            </label>
            <label className="block text-sm font-semibold text-slate-800">
              New requirement
              <textarea className={areaClass} rows={3} value={newReq} onChange={(e) => setNewReq(e.target.value)} />
            </label>
          </div>
        </section>

        <div className="space-y-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Optional workflows</p>

          {/* Optional AI section */}
          <section
            className="space-y-4 rounded-xl border border-violet-200 bg-white p-4 shadow-sm sm:p-5"
            aria-labelledby="ai-heading"
          >
            <div>
              <h2 id="ai-heading" className="flex items-center gap-2 font-semibold text-slate-900">
                <Sparkles className="size-4 text-violet-600" aria-hidden="true" /> Generate tests with Gemini (optional)
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Gemini proposes test cases from the requirement text. You review them, then run them against the same
                legacy function. AI generation must be enabled on the server and needs the demo access code.
              </p>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <label className="block text-sm font-semibold text-slate-900">
                Demo access code
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={accessCode}
                  onChange={(e) => setAccessCode(e.target.value)}
                  placeholder="Required for AI generation"
                  className="mt-1 block w-full rounded-lg border border-slate-300 bg-white p-2 text-sm font-normal text-slate-900 focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-200 sm:w-72"
                />
              </label>
              <button
                onClick={() => void generate()}
                disabled={busy}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-violet-300 bg-white px-4 py-2 font-semibold text-violet-700 hover:bg-violet-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 disabled:opacity-60 sm:w-auto"
              >
                {generating ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                {generating ? "Generating..." : "Generate Tests with AI"}
              </button>
            </div>
            <p className="text-xs text-slate-500">The access code stays in this page and is never saved.</p>

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
                  <div
                    className="flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
                    role="status"
                  >
                    <History className="mt-0.5 size-4 shrink-0" />
                    <p>
                      <strong>These cases are out of date.</strong> The requirement text has been edited since these
                      cases were generated, so they may not match it. Click &quot;Generate Tests with AI&quot; to
                      regenerate before running.
                    </p>
                  </div>
                )}
                <button
                  onClick={runGenerated}
                  disabled={busy || !generationIsCurrent}
                  title={generationIsCurrent ? undefined : "Regenerate the tests: the requirements changed"}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 py-2 font-semibold text-white shadow-sm hover:bg-violet-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 disabled:opacity-60 sm:w-auto"
                >
                  {runningFrom === "ai" ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                  {runningFrom === "ai" ? "Running..." : "Run Generated Tests"}
                </button>
                {runError?.from === "ai" && <RunError message={runError.message} />}
              </div>
            )}
          </section>

          <ScenarioEditor
            rawThreshold={rawThreshold}
            onThresholdChange={setRawThreshold}
            threshold={threshold.value}
            validationError={threshold.error}
            cases={boundaryCases}
            onRun={runScenario}
            disabled={busy}
            running={runningFrom === "scenario"}
          />
          {runError?.from === "scenario" && <RunError message={runError.message} />}
        </div>

        {snapshot && (
          <section
            className={`scroll-mt-4 space-y-4 border-t border-slate-200 pt-8 transition-opacity ${loading ? "opacity-60" : ""}`}
            aria-live="polite"
            aria-busy={loading}
            aria-labelledby="results-heading"
          >
            <div>
              <h2
                id="results-heading"
                ref={resultsHeadingRef}
                tabIndex={-1}
                className="scroll-mt-4 rounded text-xl font-bold text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
              >
                Results
              </h2>
              <p className="text-sm text-slate-600">
                {sourceLabel(snapshot.source)}
                {snapshot.scenario ? ` (proposed threshold: ${snapshot.scenario.thresholdHours} hours)` : ""}, executed
                against the legacy function.
              </p>
            </div>
            {loading && (
              <p className="flex items-center gap-2 text-xs text-slate-500">
                <Loader2 className="size-3.5 animate-spin" /> Running new tests. The results below are from the previous
                run until the new results arrive.
              </p>
            )}
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
            {verdictToShow && <VerdictBanner verdict={verdictToShow} />}
            <SummaryBar summary={snapshot.summary} />
            {expectations && (
              <p
                className={`rounded-lg border p-3 text-sm ${
                  snapshot.source === "ai"
                    ? "border-violet-300 bg-violet-50 text-violet-900"
                    : "border-slate-200 bg-white text-slate-700"
                }`}
              >
                <span className="font-semibold">Expected outcomes:</span> {expectations.description} Actual outcomes
                come from executing the legacy function.
              </p>
            )}
            <FailureExplanation failures={failures} />
            <ul className="grid gap-3">
              {snapshot.results.map((r) => (
                <ResultCard key={r.id} result={r} expectedLabel={expectations?.expectedLabel ?? "Expected"} />
              ))}
            </ul>

            <div className="space-y-3 border-t border-slate-200 pt-4">
              <button
                onClick={() => setShowEvidence((v) => !v)}
                aria-expanded={showEvidence}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-5 py-2.5 font-semibold text-slate-900 shadow-sm hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 sm:w-auto"
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
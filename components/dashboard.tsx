"use client";

import { useMemo, useState } from "react";
import { Loader2, Play, ShieldCheck, Info, AlertCircle, Sparkles, FileText, History } from "lucide-react";
import { EvidenceReport } from "@/components/evidence-report";
import { GeneratedPreview } from "@/components/generated-preview";
import { FailureExplanation } from "@/components/failure-explanation";
import { ResultCard } from "@/components/result-card";
import { SummaryBar } from "@/components/summary-bar";
import { NEW_REQUIREMENT, OLD_REQUIREMENT, SEED_CASES } from "@/lib/regression/seed";
import type { GeneratedTests } from "@/lib/ai/schema";
import type { RegressionCase, RunReport } from "@/lib/regression/types";
import {
  compareWithDraft,
  createEvidenceSnapshot,
  type AiContext,
  type EvidenceSnapshot,
  type EvidenceSource,
} from "@/lib/report/evidence";

async function readError(res: Response): Promise<string> {
  const data: unknown = await res.json().catch(() => null);
  if (data && typeof data === "object" && "error" in data && typeof data.error === "string") {
    return data.error;
  }
  return `Request failed with status ${res.status}.`;
}

export function Dashboard() {
  const [oldReq, setOldReq] = useState(OLD_REQUIREMENT);
  const [newReq, setNewReq] = useState(NEW_REQUIREMENT);
  const [snapshot, setSnapshot] = useState<EvidenceSnapshot | null>(null);
  const [showEvidence, setShowEvidence] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runningFrom, setRunningFrom] = useState<EvidenceSource | null>(null);
  const [generated, setGenerated] = useState<GeneratedTests | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  async function run(cases: readonly RegressionCase[], from: EvidenceSource, aiContext?: AiContext) {
    // Capture the draft at click time so later edits cannot leak into this run's evidence.
    const captured = { oldRequirement: oldReq, newRequirement: newReq, cases: cases.map((c) => ({ ...c })) };
    setLoading(true);
    setRunningFrom(from);
    setError(null);
    try {
      const res = await fetch("/api/run-tests", {
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
          aiContext,
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
    setGenerating(true);
    setGenError(null);
    setGenerated(null);
    try {
      const res = await fetch("/api/generate-tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldRequirement: oldReq, newRequirement: newReq }),
      });
      if (!res.ok) throw new Error(await readError(res));
      setGenerated((await res.json()) as GeneratedTests);
    } catch (e) {
      setGenError(e instanceof Error ? e.message : "Unexpected error generating tests.");
    } finally {
      setGenerating(false);
    }
  }

  function runGenerated() {
    if (!generated) return;
    // Send only the executable fields; `reason` is display-only.
    void run(
      generated.testCases.map(({ hoursBeforeStart, expectedAllowed }) => ({ hoursBeforeStart, expectedAllowed })),
      "ai",
      {
        changeSummary: generated.changeSummary,
        reasons: generated.testCases.map((c) => c.reason),
      },
    );
  }

  const divergence = useMemo(
    () =>
      snapshot
        ? compareWithDraft(snapshot, {
            oldRequirement: oldReq,
            newRequirement: newReq,
            generatedCases: generated
              ? generated.testCases.map(({ hoursBeforeStart, expectedAllowed }) => ({ hoursBeforeStart, expectedAllowed }))
              : null,
          })
        : null,
    [snapshot, oldReq, newReq, generated],
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
        <p className="text-xs text-slate-500">
          &quot;Run Regression Tests&quot; uses the built-in seeded cases and works without an API key. AI generation
          needs <code>GEMINI_API_KEY</code> on the server.
        </p>

        {genError && (
          <div role="alert" className="flex gap-2 rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <p>{genError}</p>
          </div>
        )}

        {generated && (
          <div className="space-y-3">
            <GeneratedPreview generated={generated} />
            <button
              onClick={runGenerated}
              disabled={loading || generating}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 font-semibold text-white shadow hover:bg-emerald-700 disabled:opacity-60"
            >
              {runningFrom === "ai" ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
              {runningFrom === "ai" ? "Running..." : "Run Generated Tests"}
            </button>
          </div>
        )}

        {error && (
          <div role="alert" className="flex gap-2 rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <p>{error}</p>
          </div>
        )}

        {snapshot && (
          <section className="space-y-4" aria-live="polite">
            <p className="text-sm font-semibold text-slate-700">
              Results for {snapshot.source === "ai" ? "AI-generated cases" : "seeded demo cases"} (executed by the
              legacy function)
            </p>
            {divergence?.isStale && (
              <div className="flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" role="status">
                <History className="mt-0.5 size-4 shrink-0" />
                <p>
                  <strong>Previous execution evidence.</strong>{" "}
                  {[
                    divergence.requirementsChanged && "The requirement text has been edited",
                    divergence.casesChanged && "the generated cases have changed",
                  ]
                    .filter(Boolean)
                    .join(" and ")}{" "}
                  since these tests ran. These results reflect the inputs captured in the evidence report, not the
                  current draft. Run the tests again to produce new evidence.
                </p>
              </div>
            )}
            <SummaryBar summary={snapshot.summary} />
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




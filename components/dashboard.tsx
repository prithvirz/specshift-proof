"use client";

import { useState } from "react";
import { Loader2, Play, ShieldCheck, Info, AlertCircle } from "lucide-react";
import { FailureExplanation } from "@/components/failure-explanation";
import { ResultCard } from "@/components/result-card";
import { SummaryBar } from "@/components/summary-bar";
import { NEW_REQUIREMENT, OLD_REQUIREMENT, SEED_CASES } from "@/lib/regression/seed";
import type { RunReport } from "@/lib/regression/types";

export function Dashboard() {
  const [oldReq, setOldReq] = useState(OLD_REQUIREMENT);
  const [newReq, setNewReq] = useState(NEW_REQUIREMENT);
  const [report, setReport] = useState<RunReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/run-tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cases: SEED_CASES }),
      });
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const message =
          data && typeof data === "object" && "error" in data && typeof data.error === "string"
            ? data.error
            : `Request failed with status ${res.status}.`;
        throw new Error(message);
      }
      setReport(data as RunReport);
    } catch (e) {
      setReport(null);
      setError(e instanceof Error ? e.message : "Unexpected error running tests.");
    } finally {
      setLoading(false);
    }
  }

  const failures = report?.results.filter((r) => r.status === "fail") ?? [];
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
            Phase 1 demo. The requirement text below is informational only. Editing it does not regenerate tests
            or change business logic. The three seeded cases always run against the real legacy
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

        <button
          onClick={run}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2.5 font-semibold text-white shadow hover:bg-indigo-700 disabled:opacity-60"
        >
          {loading ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
          {loading ? "Running..." : "Run Regression Tests"}
        </button>

        {error && (
          <div role="alert" className="flex gap-2 rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <p>{error}</p>
          </div>
        )}

        {report && (
          <section className="space-y-4" aria-live="polite">
            <SummaryBar summary={report.summary} />
            <FailureExplanation failures={failures} />
            <ul className="grid gap-3">
              {report.results.map((r) => (
                <ResultCard key={r.id} result={r} />
              ))}
            </ul>
          </section>
        )}
      </main>
    </div>
  );
}

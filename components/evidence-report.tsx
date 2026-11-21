"use client";

import { useState } from "react";
import { Check, ChevronDown, ClipboardCopy, FileText, XCircle } from "lucide-react";
import { LEGACY_CANCELLATION_THRESHOLD_HOURS } from "@/lib/legacy/cancellation";
import { describeProposedRule } from "@/lib/scenario/boundary";
import {
  describeBehavior,
  explainDirection,
  explainMismatch,
  noRegressionMessage,
  failedResults,
  passedResults,
  sourceLabel,
  toMarkdown,
  type EvidenceSnapshot,
} from "@/lib/report/evidence";

type CopyState = "idle" | "copied" | "failed";

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

function RequirementBlock({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</h4>
      <blockquote className="mt-1 whitespace-pre-wrap rounded-lg border-l-4 border-slate-300 bg-slate-50 p-3 text-sm text-slate-800">
        {text}
      </blockquote>
    </div>
  );
}

export function EvidenceReport({ snapshot, isStale }: { snapshot: EvidenceSnapshot; isStale: boolean }) {
  const [copy, setCopy] = useState<CopyState>("idle");
  const failed = failedResults(snapshot);
  const passed = passedResults(snapshot);
  const reasonFor = (id: number) => snapshot.aiContext?.reasons[id - 1];

  async function copyReport() {
    try {
      await navigator.clipboard.writeText(toMarkdown(snapshot));
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
    setTimeout(() => setCopy("idle"), 2500);
  }

  const meta: Array<{ label: string; value: string; title?: string }> = [
    { label: "Test source", value: sourceLabel(snapshot.source) },
    ...(snapshot.scenario ? [{ label: "Proposed threshold", value: `${snapshot.scenario.thresholdHours} hours` }] : []),
    { label: "Executed at", value: formatTimestamp(snapshot.executedAt), title: snapshot.executedAt },
    { label: "Total", value: String(snapshot.summary.total) },
    { label: "Passed", value: String(snapshot.summary.passed) },
    { label: "Failed", value: String(snapshot.summary.failed) },
  ];

  return (
    <article className="space-y-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm" aria-label="Regression evidence report">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-lg font-bold text-slate-900">
            <FileText className="size-5 text-indigo-600" /> Regression Evidence Report
          </h3>
          <p className="text-sm text-slate-500">
            Function under test: <code>canCancelBooking</code> (legacy rule{" "}
            <code>hoursBeforeStart &gt;= {LEGACY_CANCELLATION_THRESHOLD_HOURS}</code>). Pass/fail comes from executing it.
          </p>
        </div>
        <button
          onClick={() => void copyReport()}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-800 hover:bg-slate-50"
        >
          {copy === "copied" ? <Check className="size-4 text-emerald-600" /> : <ClipboardCopy className="size-4" />}
          {copy === "copied" ? "Copied" : copy === "failed" ? "Copy failed" : "Copy Report"}
        </button>
      </header>

      {isStale && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Previous execution evidence. It reflects the requirements and cases captured below, not your current draft.
        </p>
      )}

      <dl className={`grid grid-cols-2 gap-3 ${meta.length > 5 ? "sm:grid-cols-6" : "sm:grid-cols-5"}`}>
        {meta.map((m) => (
          <div key={m.label} className="rounded-lg bg-slate-50 p-3">
            <dt className="text-xs text-slate-500">{m.label}</dt>
            <dd className="text-sm font-semibold text-slate-900" title={m.title}>
              {m.value}
            </dd>
          </div>
        ))}
      </dl>

      <section className="space-y-3">
        <h4 className="font-semibold text-slate-900">Written requirements captured at execution time</h4>
        <div className="grid gap-3 md:grid-cols-2">
          <RequirementBlock label="Old requirement" text={snapshot.oldRequirement} />
          <RequirementBlock label="New requirement" text={snapshot.newRequirement} />
        </div>
        {snapshot.scenario && (
          <div className="rounded-lg border border-teal-200 bg-teal-50 p-3 text-sm text-teal-900">
            <p className="font-semibold">Proposed scenario rule (determines expected outcomes)</p>
            <p className="mt-1">
              <code>{describeProposedRule(snapshot.scenario.thresholdHours)}</code>, set in the scenario editor.
            </p>
            <p className="mt-1 text-xs">
              The written requirements above are recorded for context only and were not interpreted.
            </p>
          </div>
        )}
        {snapshot.aiContext && (
          <p className="rounded-lg bg-violet-50 p-3 text-sm text-violet-900">
            <span className="font-semibold">Gemini change summary (context only, not evidence):</span>{" "}
            {snapshot.aiContext.changeSummary}
          </p>
        )}
      </section>

      <section className="space-y-3">
        <h4 className="font-semibold text-slate-900">Failed cases ({failed.length})</h4>
        {failed.length === 0 ? (
          <p className={snapshot.scenario ? "text-sm font-semibold text-emerald-700" : "text-sm text-slate-600"}>
            {snapshot.scenario ? noRegressionMessage(snapshot.scenario.thresholdHours) : "No failures."}
          </p>
        ) : (
          <ul className="space-y-3">
            {failed.map((r) => (
              <li key={r.id} className="rounded-lg border border-rose-200 bg-rose-50 p-4">
                <p className="flex items-center gap-2 font-semibold text-rose-900">
                  <XCircle className="size-4" /> Case {r.id}
                </p>
                <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-slate-500">Input</dt>
                    <dd className="font-mono">hoursBeforeStart = {r.hoursBeforeStart}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Expected</dt>
                    <dd>{describeBehavior(r.expectedAllowed)}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Actual</dt>
                    <dd>{describeBehavior(r.actualAllowed)}</dd>
                  </div>
                </dl>
                <p className="mt-2 text-sm text-slate-800">
                  {explainMismatch(r)} {explainDirection(r)}
                </p>
                {reasonFor(r.id) && (
                  <p className="mt-1 text-xs text-slate-500">Gemini&apos;s rationale for this case: {reasonFor(r.id)}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <details className="group rounded-lg border border-slate-200">
        <summary className="flex cursor-pointer list-none items-center justify-between p-3 font-semibold text-slate-900">
          Passed cases ({passed.length})
          <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
        </summary>
        {passed.length === 0 ? (
          <p className="px-3 pb-3 text-sm text-slate-600">No passing cases.</p>
        ) : (
          <div className="overflow-x-auto px-3 pb-3">
            <table className="w-full text-left text-sm">
              <thead className="text-slate-500">
                <tr>
                  <th className="py-1 pr-4 font-medium">Case</th>
                  <th className="py-1 pr-4 font-medium">Input (hours)</th>
                  <th className="py-1 pr-4 font-medium">Expected</th>
                  <th className="py-1 font-medium">Actual</th>
                </tr>
              </thead>
              <tbody>
                {passed.map((r) => (
                  <tr key={r.id} className="border-t border-slate-100">
                    <td className="py-1 pr-4">{r.id}</td>
                    <td className="py-1 pr-4 font-mono">{r.hoursBeforeStart}</td>
                    <td className="py-1 pr-4">{describeBehavior(r.expectedAllowed)}</td>
                    <td className="py-1">{describeBehavior(r.actualAllowed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </article>
  );
}

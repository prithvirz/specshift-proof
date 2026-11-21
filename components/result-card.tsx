import { CheckCircle2, XCircle } from "lucide-react";
import type { CaseResult } from "@/lib/regression/types";

const label = (allowed: boolean) => (allowed ? "Allowed (true)" : "Blocked (false)");

export function ResultCard({ result, expectedLabel }: { result: CaseResult; expectedLabel: string }) {
  const pass = result.status === "pass";
  return (
    <li
      className={`rounded-xl border p-4 ${
        pass ? "border-emerald-200 bg-emerald-50" : "border-rose-200 bg-rose-50"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold text-slate-900">
          Case {result.id}: {result.hoursBeforeStart}h before start
        </h3>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
            pass ? "bg-emerald-600 text-white" : "bg-rose-600 text-white"
          }`}
        >
          {pass ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
          {pass ? "PASS" : "FAIL"}
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-slate-500">Input</dt>
          <dd className="font-mono text-slate-900">hoursBeforeStart = {result.hoursBeforeStart}</dd>
        </div>
        <div>
          <dt className="text-slate-500">{expectedLabel}</dt>
          <dd className="font-mono text-slate-900">{label(result.expectedAllowed)}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Actual (legacy function)</dt>
          <dd className="font-mono text-slate-900">{label(result.actualAllowed)}</dd>
        </div>
      </dl>
      <p className="mt-3 text-sm text-slate-700">{result.explanation}</p>
    </li>
  );
}

import { Sparkles } from "lucide-react";
import type { GenerationRecord } from "@/lib/ai/generation-record";

export function GeneratedPreview({ generated }: { generated: GenerationRecord["output"] }) {
  return (
    <section className="space-y-4 rounded-xl border border-violet-200 bg-white p-5 shadow-sm" aria-label="AI-generated tests">
      <div className="rounded-lg bg-violet-50 p-4">
        <h2 className="flex items-center gap-2 font-semibold text-violet-900">
          <Sparkles className="size-4" /> Change summary (AI-generated)
        </h2>
        <p className="mt-1 text-sm text-violet-900">{generated.changeSummary}</p>
      </div>
      <div>
        <h3 className="text-sm font-semibold text-slate-900">
          Proposed test cases ({generated.testCases.length}). Review before running.
        </h3>
        <ul className="mt-2 divide-y divide-slate-200 rounded-lg border border-slate-200">
          {generated.testCases.map((c, i) => (
            <li key={c.hoursBeforeStart} className="grid gap-1 p-3 text-sm sm:grid-cols-[10rem_9rem_1fr]">
              <span className="font-mono text-slate-900">
                #{i + 1} hours = {c.hoursBeforeStart}
              </span>
              <span className="font-mono text-slate-700">expects {c.expectedAllowed ? "allowed" : "blocked"}</span>
              <span className="text-slate-600">{c.reason}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-slate-500">
          These expected outcomes were proposed by Gemini and may be incorrect. Running them executes the real legacy function, and pass/fail compares its actual result with each expectation.
        </p>
      </div>
    </section>
  );
}

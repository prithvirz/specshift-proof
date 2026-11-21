import { AlertTriangle } from "lucide-react";
import type { CaseResult } from "@/lib/regression/types";
import { explainDirection, explainMismatch } from "@/lib/report/evidence";

export function FailureExplanation({ failures }: { failures: readonly CaseResult[] }) {
  if (failures.length === 0) return null;
  return (
    <section className="rounded-xl border border-amber-300 bg-amber-50 p-5" aria-label="Failure explanation">
      <h2 className="flex items-center gap-2 font-semibold text-amber-900">
        <AlertTriangle className="size-5" /> Why did this regression occur?
      </h2>
      {failures.map((f) => (
        <p key={f.id} className="mt-2 text-sm text-amber-900">
          <strong>Case {f.id}.</strong> {explainMismatch(f)} {explainDirection(f)}
        </p>
      ))}
    </section>
  );
}

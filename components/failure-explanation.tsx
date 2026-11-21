import { AlertTriangle } from "lucide-react";
import { LEGACY_CANCELLATION_THRESHOLD_HOURS } from "@/lib/legacy/cancellation";
import type { CaseResult } from "@/lib/regression/types";

export function FailureExplanation({ failures }: { failures: CaseResult[] }) {
  if (failures.length === 0) return null;
  return (
    <section className="rounded-xl border border-amber-300 bg-amber-50 p-5" aria-label="Failure explanation">
      <h2 className="flex items-center gap-2 font-semibold text-amber-900">
        <AlertTriangle className="size-5" /> Why did this regression occur?
      </h2>
      {failures.map((f) => (
        <p key={f.id} className="mt-2 text-sm text-amber-900">
          Case {f.id} ({f.hoursBeforeStart} hours before start) expects cancellation to be{" "}
          <strong>{f.expectedAllowed ? "allowed" : "blocked"}</strong>, but the legacy function returned{" "}
          <strong>{f.actualAllowed ? "allowed" : "blocked"}</strong>. The legacy{" "}
          <code className="rounded bg-amber-100 px-1">canCancelBooking</code> still implements the old rule
          (<code className="rounded bg-amber-100 px-1">hoursBeforeStart &gt;= {LEGACY_CANCELLATION_THRESHOLD_HOURS}</code>
          ), so {f.hoursBeforeStart} hours is rejected even though the new 2-hour requirement allows it.
        </p>
      ))}
    </section>
  );
}

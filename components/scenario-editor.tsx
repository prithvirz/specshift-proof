import { Loader2, Play, SlidersHorizontal } from "lucide-react";
import {
  MAX_SCENARIO_THRESHOLD,
  MIN_SCENARIO_THRESHOLD,
  describeProposedRule,
  type BoundaryCase,
} from "@/lib/scenario/boundary";

interface ScenarioEditorProps {
  rawThreshold: string;
  onThresholdChange: (value: string) => void;
  /** Parsed threshold, or null when the input is invalid. */
  threshold: number | null;
  validationError: string | null;
  cases: readonly BoundaryCase[];
  onRun: () => void;
  disabled: boolean;
  running: boolean;
}

export function ScenarioEditor({
  rawThreshold,
  onThresholdChange,
  threshold,
  validationError,
  cases,
  onRun,
  disabled,
  running,
}: ScenarioEditorProps) {
  return (
    <section className="space-y-4 rounded-xl border border-teal-200 bg-white p-5 shadow-sm" aria-label="Scenario editor">
      <div>
        <h2 className="flex items-center gap-2 font-semibold text-slate-900">
          <SlidersHorizontal className="size-4 text-teal-600" /> Scenario editor (deterministic)
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Choose a proposed cancellation threshold. Boundary cases are generated from this number alone. The
          requirement text above is not read or interpreted, and Gemini is not used.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <label className="block text-sm font-semibold text-slate-900">
          Proposed threshold (hours)
          <input
            type="number"
            inputMode="numeric"
            min={MIN_SCENARIO_THRESHOLD}
            max={MAX_SCENARIO_THRESHOLD}
            step={1}
            value={rawThreshold}
            onChange={(e) => onThresholdChange(e.target.value)}
            aria-invalid={validationError !== null}
            aria-describedby="scenario-threshold-help"
            className="mt-1 block w-32 rounded-lg border border-slate-300 bg-white p-2 text-sm text-slate-900 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-200 aria-[invalid=true]:border-rose-400"
          />
        </label>
        <p id="scenario-threshold-help" className="pb-2 text-sm text-slate-700">
          {threshold !== null ? (
            <>
              Proposed rule: <code className="rounded bg-teal-50 px-1">{describeProposedRule(threshold)}</code>
            </>
          ) : (
            <span className="text-rose-700">{validationError}</span>
          )}
        </p>
      </div>

      <p className="rounded-lg bg-teal-50 p-3 text-xs text-teal-900">
        This number decides the expected outcomes, independently of the written requirements. If the text says
        something different, the scenario still uses {threshold ?? "the number entered"} hours. Actual outcomes always
        come from running the legacy 24-hour function.
      </p>

      {threshold !== null && (
        <div>
          <h3 className="text-sm font-semibold text-slate-900">
            Boundary cases ({cases.length}). Expected outcomes under the proposed rule.
          </h3>
          <ul className="mt-2 divide-y divide-slate-200 rounded-lg border border-slate-200">
            {cases.map((c, i) => (
              <li key={c.hoursBeforeStart} className="grid gap-1 p-3 text-sm sm:grid-cols-[10rem_9rem_1fr]">
                <span className="font-mono text-slate-900">
                  #{i + 1} hours = {c.hoursBeforeStart}
                </span>
                <span className="font-mono text-slate-700">expects {c.expectedAllowed ? "allowed" : "blocked"}</span>
                <span className="text-slate-600">{c.notes.join("; ")}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <button
        onClick={onRun}
        disabled={disabled || threshold === null}
        className="inline-flex items-center gap-2 rounded-lg bg-teal-600 px-5 py-2.5 font-semibold text-white shadow hover:bg-teal-700 disabled:opacity-60"
      >
        {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
        {running ? "Running..." : "Run Scenario Tests"}
      </button>
    </section>
  );
}

import type { RunSummary } from "@/lib/regression/types";

export function SummaryBar({ summary }: { summary: RunSummary }) {
  const items = [
    { label: "Total", value: summary.total, style: "text-slate-900" },
    { label: "Passed", value: summary.passed, style: "text-emerald-600" },
    { label: "Failed", value: summary.failed, style: "text-rose-600" },
  ];
  return (
    <div className="grid grid-cols-3 gap-3" aria-label="Test summary">
      {items.map((item) => (
        <div key={item.label} className="rounded-xl border border-slate-200 bg-white p-4 text-center shadow-sm">
          <div className={`text-3xl font-bold ${item.style}`}>{item.value}</div>
          <div className="text-xs uppercase tracking-wide text-slate-500">{item.label}</div>
        </div>
      ))}
    </div>
  );
}

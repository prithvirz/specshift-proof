import { AlertOctagon, AlertTriangle, CheckCircle2 } from "lucide-react";
import type { Verdict, VerdictTone } from "@/lib/report/verdict";

const STYLES: Record<VerdictTone, { box: string; icon: typeof CheckCircle2 }> = {
  regression: { box: "border-rose-600 bg-rose-600 text-white", icon: AlertOctagon },
  mismatch: { box: "border-rose-300 bg-rose-50 text-rose-900", icon: AlertTriangle },
  pass: { box: "border-emerald-600 bg-emerald-600 text-white", icon: CheckCircle2 },
};

export function VerdictBanner({ verdict }: { verdict: Verdict }) {
  const { box, icon: Icon } = STYLES[verdict.tone];
  return (
    <div className={`flex items-start gap-3 rounded-xl border-2 p-4 shadow-sm ${box}`} role="status">
      <Icon className="mt-0.5 size-6 shrink-0" aria-hidden="true" />
      <div>
        <p className="text-lg font-bold leading-tight">{verdict.title}</p>
        <p className="text-sm font-semibold">{verdict.detail}</p>
        {verdict.note && <p className="mt-1 text-sm">{verdict.note}</p>}
      </div>
    </div>
  );
}

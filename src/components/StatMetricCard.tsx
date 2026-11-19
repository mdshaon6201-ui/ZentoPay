import React from 'react';
import type { LucideIcon } from 'lucide-react';

interface StatMetricCardProps {
  label: string;
  value: string;
  helper: string;
  icon: LucideIcon;
  tone?: 'default' | 'emerald' | 'amber';
}

export function StatMetricCard({
  label,
  value,
  helper,
  icon: Icon,
  tone = 'default',
}: StatMetricCardProps) {
  const iconStyles =
    tone === 'emerald'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : tone === 'amber'
      ? 'bg-amber-50 text-amber-700 border-amber-200'
      : 'bg-slate-50 text-slate-700 border-slate-200';

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-4">
      <div className="flex items-start justify-between gap-3">
        <span className="text-sm font-medium text-slate-600">{label}</span>
        <span
          className={`w-9 h-9 rounded-lg border flex items-center justify-center shrink-0 ${iconStyles}`}
          aria-hidden="true"
        >
          <Icon className="w-4 h-4" />
        </span>
      </div>
      <div>
        <div className="font-display text-2xl font-bold tracking-tight text-slate-900 tabular-nums">
          {value}
        </div>
        <p className="mt-1 text-xs text-slate-500">{helper}</p>
      </div>
    </div>
  );
}

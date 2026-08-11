import type { LucideIcon } from "lucide-react";

export interface MetricCardProps {
  title: string;
  icon: LucideIcon;
  metrics: { label: string; value: string | number }[];
}

export function MetricCard({ title, icon: Icon, metrics }: MetricCardProps) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="size-4" />
        </span>
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      </div>
      <dl className="space-y-1.5">
        {metrics.map((m) => (
          <div key={m.label} className="flex items-center justify-between text-sm">
            <dt className="text-muted-foreground">{m.label}</dt>
            <dd className="font-medium text-foreground">{m.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

"use client";

// Gráficos do relatório de Atendimentos (2 pizzas + 1 barra). Ficam num módulo à parte para a página
// carregá-los sob demanda (next/dynamic): o Recharts não entra no JS inicial da rota.
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface PieDatum {
  name: string;
  value: number;
  color: string;
}

export interface BarDatum {
  name: string;
  "Atendimentos %": number;
  "Mensagens %": number;
}

// Tooltip dos gráficos nos tokens do tema (o padrão do Recharts é branco, ilegível no escuro).
const TOOLTIP_STYLE = {
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--popover-foreground)",
} as const;

function renderPieLabel({ percent }: { percent?: number }) {
  return `${Math.round((percent ?? 0) * 100)}%`;
}

function PieBlock({ data, ariaLabel }: { data: PieDatum[]; ariaLabel: string }) {
  return (
    <div role="img" aria-label={ariaLabel}>
      <ResponsiveContainer width="100%" height={260}>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" outerRadius={90} label={renderPieLabel}>
            {data.map((entry) => (
              <Cell key={entry.name} fill={entry.color} />
            ))}
          </Pie>
          <RechartsTooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: "var(--popover-foreground)" }} />
          <Legend />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

export function AtendimentosPie({ data, ariaLabel }: { data: PieDatum[]; ariaLabel: string }) {
  return <PieBlock data={data} ariaLabel={ariaLabel} />;
}

export function AtendimentosBars({
  data,
  ariaLabel,
  colors,
}: {
  data: BarDatum[];
  ariaLabel: string;
  colors: readonly [string, string];
}) {
  return (
    <div role="img" aria-label={ariaLabel}>
      <ResponsiveContainer width="100%" height={Math.max(200, data.length * 44 + 40)}>
        <BarChart data={data} layout="vertical" margin={{ left: 16, right: 16 }}>
          <CartesianGrid horizontal={false} stroke="var(--border)" />
          <XAxis type="number" domain={[0, 100]} unit="%" stroke="var(--muted-foreground)" />
          <YAxis type="category" dataKey="name" width={140} stroke="var(--muted-foreground)" />
          <RechartsTooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: "var(--popover-foreground)" }} />
          <Legend />
          <Bar dataKey="Atendimentos %" fill={colors[0]} radius={[0, 4, 4, 0]} />
          <Bar dataKey="Mensagens %" fill={colors[1]} radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

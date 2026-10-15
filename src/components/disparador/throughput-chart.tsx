"use client";

// Gráfico de envios por minuto de /disparador/desempenho. Fica à parte para a página carregá-lo sob demanda
// (next/dynamic): o Recharts não entra no JS inicial da rota.
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend } from "recharts";

import type { ThroughputDataPoint } from "@/lib/disparador/desempenho";

export function ThroughputChart({
  data,
  keys,
  palette,
}: {
  data: ThroughputDataPoint[];
  keys: string[];
  palette: readonly string[];
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 10, right: 20, left: -10, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.2} vertical={false} />
        <XAxis dataKey="displayTime" tick={{ fontSize: 11 }} stroke="currentColor" opacity={0.5} />
        <YAxis tick={{ fontSize: 11 }} stroke="currentColor" opacity={0.5} allowDecimals={false} />
        <RechartsTooltip
          contentStyle={{
            backgroundColor: "var(--popover)",
            borderColor: "var(--border)",
            borderRadius: "8px",
            fontSize: "12px",
            boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
          }}
          labelStyle={{ fontWeight: "bold", marginBottom: "4px" }}
        />
        <Legend wrapperStyle={{ fontSize: "11px", paddingTop: "12px" }} />
        {keys.map((keyName, idx) => (
          <Line
            key={keyName}
            type="monotone"
            dataKey={keyName}
            name={keyName}
            stroke={palette[idx % palette.length]}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

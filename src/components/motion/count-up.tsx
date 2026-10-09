"use client";

import { useEffect, useRef, useState } from "react";

import { COUNT_UP_MS, countUpValue, prefersReducedMotion, shouldCountUp } from "@/lib/motion";

const defaultFormat = (n: number) => Math.round(n).toLocaleString("pt-BR");

interface CountUpProps {
  /** Valor real (nunca fictício). Mudou → anima do valor anterior até o novo. */
  value: number;
  /** Formata o número exibido (padrão: inteiro pt-BR). Recebe o valor intermediário. */
  format?: (n: number) => string;
  className?: string;
}

/**
 * Número que conta até o valor (KPIs, contadores) — porte do countUp do
 * protótipo: 900ms, desaceleração quártica, tabular-nums para não pular.
 * Com movimento reduzido, ou valor pequeno, mostra o valor direto.
 * Leitores de tela recebem só o valor final (aria-label), não a contagem.
 */
export function CountUp({ value, format = defaultFormat, className }: CountUpProps) {
  // Quadro da animação em curso, amarrado ao alvo: se `value` mudar no
  // meio, o quadro antigo deixa de valer e o valor real aparece na hora.
  // Começa em 0 (como no protótipo) para não piscar o valor final antes
  // da contagem; mesmo valor no servidor e no cliente (sem hydration mismatch).
  const [frame, setFrame] = useState<{ target: number; n: number } | null>(() =>
    shouldCountUp(value) ? { target: value, n: 0 } : null,
  );
  const fromRef = useRef(0);

  useEffect(() => {
    const from = fromRef.current;
    fromRef.current = value;
    let raf = 0;
    if (!shouldCountUp(value) || from === value || prefersReducedMotion()) {
      // Sem animação: descarta o quadro inicial no próximo frame.
      raf = requestAnimationFrame(() => setFrame(null));
      return () => cancelAnimationFrame(raf);
    }
    const start = performance.now();
    const tick = (now: number) => {
      const elapsed = now - start;
      if (elapsed >= COUNT_UP_MS) {
        setFrame(null);
        return;
      }
      setFrame({ target: value, n: countUpValue(from, value, elapsed) });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  const shown = frame && frame.target === value ? frame.n : value;

  return (
    <span className={className} style={{ fontVariantNumeric: "tabular-nums" }} aria-label={format(value)}>
      <span aria-hidden="true">{format(shown)}</span>
    </span>
  );
}

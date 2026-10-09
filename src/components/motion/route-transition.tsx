"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

import { EASE_DDM, prefersReducedMotion } from "@/lib/motion";

/**
 * Entrada de página do protótipo DDM (ddmUp: sobe 8px + fade, .42s) a cada
 * troca de rota. Usa a Web Animations API no próprio contêiner em vez de
 * `key={pathname}`: nada remonta — layouts aninhados (Disparador,
 * Relatórios) mantêm estado e dados ao trocar de aba. Só o pathname dispara;
 * mudar ?query (filtros, conversa aberta no Inbox) não anima.
 */
export function RouteTransition({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof el.animate !== "function" || prefersReducedMotion()) return;
    const animation = el.animate(
      [
        { opacity: 0, transform: "translateY(8px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 420, easing: EASE_DDM },
    );
    return () => animation.cancel();
  }, [pathname]);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

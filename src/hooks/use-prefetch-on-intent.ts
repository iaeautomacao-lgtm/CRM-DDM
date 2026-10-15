"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";

import { createPrefetcher } from "@/lib/prefetch";

/**
 * Props de intenção para um <Link> do menu: mouse, foco e toque pré-carregam a tela (uma vez por destino).
 * Uso: <Link href={h} {...intent(h)}>.
 */
export function usePrefetchOnIntent() {
  const router = useRouter();
  return useMemo(() => {
    const prefetch = createPrefetcher((path) => router.prefetch(path));
    return (href: string) => ({
      onPointerEnter: () => void prefetch(href),
      onFocus: () => void prefetch(href),
      onTouchStart: () => void prefetch(href),
    });
  }, [router]);
}

"use client";

import type { ReactNode } from "react";

import { usePermission } from "@/hooks/use-permission";
import type { Permission } from "@/lib/auth/permissions";

interface CanProps {
  /** Permissão do catálogo (lib/auth/permissions.ts) exigida pelo servidor para a ação. */
  permission: Permission;
  /** O que mostrar sem a permissão ou enquanto carrega (padrão: nada). */
  fallback?: ReactNode;
  children: ReactNode;
}

/**
 * `<Can permission="members.invite">…</Can>` — mostra a ação só para quem o
 * servidor autoriza (GET /api/me/permissions). Substitui `<RequireRole>`
 * onde existe uma permissão exata para a ação: papéis personalizados
 * (PRD 20) passam a funcionar sem mudar a tela.
 */
export function Can({ permission, fallback = null, children }: CanProps) {
  return usePermission(permission) ? <>{children}</> : <>{fallback}</>;
}

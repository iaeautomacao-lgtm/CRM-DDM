"use client";

import { useMemo } from "react";

import { useAuth } from "@/hooks/use-auth";
import { useMePermissions } from "@/hooks/use-me-permissions";
import { canOpenPage } from "@/lib/auth/page-access";
import { canAccessRoute } from "@/lib/role-utils";
import type { MePermissions } from "@/lib/auth/me-permissions";
import type { Permission } from "@/lib/auth/permissions";

export interface PermissionsApi {
  loading: boolean;
  error: boolean;
  me: MePermissions | null;
  /** O servidor concede a permissão? Nega enquanto carrega (fail-closed). */
  can: (permission: Permission) => boolean;
  /** Pode abrir a página (pelas `pages` do servidor)? Nega enquanto carrega. */
  canOpen: (pathname: string) => boolean;
}

/**
 * Permissões do usuário logado, vindas do servidor (GET /api/me/permissions).
 * Fonte única do front para mostrar/esconder ações e telas: o servidor
 * decide e continua bloqueando; aqui só não se oferece o que daria 403.
 * O objeto é estável entre renders enquanto nada muda (seguro em deps).
 */
export function usePermissions(): PermissionsApi {
  const { data, loading, error } = useMePermissions();
  const { accountRole } = useAuth();

  return useMemo(() => {
    const granted = new Set<string>(data?.permissions ?? []);
    return {
      loading,
      error,
      me: data,
      can: (permission: Permission) => granted.has(permission),
      canOpen: (pathname: string): boolean => {
        if (data) return canOpenPage(data.pages, pathname);
        // Se a leitura falhou, cai na regra por papel — a mesma que o
        // servidor usa para montar `pages` — para não trancar o usuário
        // fora do app por um erro de rede. O servidor segue bloqueando.
        if (error && accountRole) return canAccessRoute(accountRole, pathname);
        return false;
      },
    };
  }, [data, loading, error, accountRole]);
}

/** Atalho para uma permissão: `const canReply = usePermission("inbox.reply")`. */
export function usePermission(permission: Permission): boolean {
  return usePermissions().can(permission);
}

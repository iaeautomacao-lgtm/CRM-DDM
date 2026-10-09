"use client";

import { useEffect, useState } from "react";

import { apiFetch } from "@/lib/api-fetch";
import { useAuth } from "@/hooks/use-auth";
import type { MePermissions } from "@/lib/auth/me-permissions";

// Cliente de GET /api/me/permissions (PRD 20, contrato em
// lib/auth/me-permissions.ts). O servidor decide; o front só consome.
// Uma busca por usuário logado, compartilhada por todos os componentes
// (cache em módulo); troca de usuário/conta invalida.

let cache: { key: string; promise: Promise<MePermissions> } | null = null;

function fetchMePermissions(key: string): Promise<MePermissions> {
  if (cache?.key === key) return cache.promise;
  const promise = apiFetch("/api/me/permissions").then(async (res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as MePermissions;
  });
  cache = { key, promise };
  // Falha não fica em cache: a próxima montagem tenta de novo.
  promise.catch(() => {
    if (cache?.promise === promise) cache = null;
  });
  return promise;
}

export interface MePermissionsState {
  /** null enquanto carrega ou se a busca falhou. */
  data: MePermissions | null;
  loading: boolean;
  error: boolean;
}

export function useMePermissions(): MePermissionsState {
  const { user, accountId } = useAuth();
  const key = user && accountId ? `${user.id}:${accountId}` : null;
  const [state, setState] = useState<{ key: string | null; data: MePermissions | null; error: boolean }>({
    key: null,
    data: null,
    error: false,
  });

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    fetchMePermissions(key).then(
      (data) => {
        if (!cancelled) setState({ key, data, error: false });
      },
      () => {
        if (!cancelled) setState({ key, data: null, error: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key]);

  // Estado de outro usuário (troca de conta) não vale para o atual.
  const current = state.key === key ? state : null;
  return {
    data: current?.data ?? null,
    loading: !!key && !current,
    error: current?.error ?? false,
  };
}

"use client";

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "@/lib/api-fetch";
import type { RoleItem } from "@/lib/roles/editor";

/**
 * Cargos da organização (GET /api/account/roles, members.view): sistema + personalizados, já com os campos de hierarquia
 * (assignable, editable...). `enabled=false` não consulta (ex.: diálogo fechado).
 */
export function useRoles(enabled = true) {
  const [roles, setRoles] = useState<RoleItem[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch("/api/account/roles", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setRoles(((await res.json()) as { roles: RoleItem[] }).roles);
      setError(false);
    } catch {
      setRoles([]);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);

  return { roles, loading, error, reload };
}

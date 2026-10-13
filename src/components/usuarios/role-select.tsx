"use client";

import { useMemo } from "react";

import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ROLE_META } from "@/components/settings/role-meta";
import type { RoleItem } from "@/lib/roles/editor";

/**
 * Seletor de cargo para convite/importação/atribuição. Recebe a lista JÁ filtrada (assignableRoles): só aparecem cargos abaixo
 * de quem convida. Agrupa em "Cargos de sistema" e "Cargos personalizados"; o personalizado mostra a que cargo de sistema
 * equivale no acesso aos dados.
 */
export function RoleSelect({
  id,
  value,
  roles,
  onChange,
  disabled,
  placeholder = "Escolha o cargo",
  className,
}: {
  id?: string;
  value: string | null;
  roles: readonly RoleItem[];
  onChange: (role: RoleItem) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const system = useMemo(() => roles.filter((r) => r.kind === "system"), [roles]);
  const custom = useMemo(() => roles.filter((r) => r.kind === "custom"), [roles]);
  const current = roles.find((r) => r.id === value) ?? null;

  return (
    <div className="space-y-1.5">
      <Select
        value={value ?? ""}
        onValueChange={(v) => {
          const picked = roles.find((r) => r.id === v);
          if (picked) onChange(picked);
        }}
        disabled={disabled}
      >
        <SelectTrigger id={id} className={className ?? "w-full"} disabled={disabled}>
          <SelectValue>{(v: string | null) => roles.find((r) => r.id === v)?.name ?? placeholder}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {system.length > 0 && (
            <SelectGroup>
              <SelectLabel>Cargos de sistema</SelectLabel>
              {system.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          {custom.length > 0 && (
            <SelectGroup>
              <SelectLabel>Cargos personalizados</SelectLabel>
              {custom.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
        </SelectContent>
      </Select>
      {current?.kind === "custom" && (
        <p className="text-xs text-muted-foreground">No acesso aos dados, este cargo equivale a {ROLE_META[current.compat_role].label}.</p>
      )}
      {roles.length === 0 && <p className="text-xs text-muted-foreground">Nenhum cargo disponível abaixo do seu.</p>}
    </div>
  );
}

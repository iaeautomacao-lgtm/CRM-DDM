"use client";

// /perfil — self-service profile + security, accessible to every role
// (ROUTE_ALLOWLIST["/perfil"] = all four roles), unlike /settings
// (owner/admin only). ProfileForm and SecurityPanel are the exact
// same components /settings?tab=profile and /settings?tab=security
// already render — reused as-is, no new API routes.

import { ProfileForm } from "@/components/settings/profile-form";
import { SecurityPanel } from "@/components/settings/security-panel";

export default function PerfilPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Meu Perfil</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Suas informações pessoais e configurações de segurança.
        </p>
      </div>

      <div className="space-y-6">
        <ProfileForm />
        <SecurityPanel />
      </div>
    </div>
  );
}

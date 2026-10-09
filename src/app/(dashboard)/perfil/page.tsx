"use client";

// /perfil — self-service profile + security, accessible to every role
// (ROUTE_ALLOWLIST["/perfil"] = all four roles), unlike /settings
// (owner/admin only). ProfileForm and SecurityPanel are the exact
// same components /settings?tab=profile and /settings?tab=security
// already render — reused as-is, no new API routes.

import { PageBody } from "@/components/ddm/page-toolbar";
import { ProfileForm } from "@/components/settings/profile-form";
import { PanelHeadingLevel } from "@/components/settings/settings-panel-head";
import { SecurityPanel } from "@/components/settings/security-panel";
import { PushSettingsCard } from "@/components/push/push-settings-card";

export default function PerfilPage() {
  return (
    <PageBody className="gap-6">
      <div className="flex flex-col gap-1.5 pt-1">
        <h2 className="font-heading text-[28px] font-semibold leading-tight tracking-[-0.025em] text-foreground">Meu perfil</h2>
        <p className="max-w-[620px] text-sm leading-relaxed text-muted-foreground">
          Suas informações pessoais, segurança e notificações.
        </p>
      </div>

      <PanelHeadingLevel level={3}>
        <div className="grid animate-ddm-fade items-start gap-6 lg:grid-cols-2">
          <ProfileForm />
          <div className="flex flex-col gap-6">
            <SecurityPanel />
            <PushSettingsCard />
          </div>
        </div>
      </PanelHeadingLevel>
    </PageBody>
  );
}

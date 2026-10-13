"use client";

// /perfil — a única tela da conta pessoal, para todos os papéis: abas Perfil · Segurança · Aparência
// (?tab=perfil|seguranca|aparencia). Reaproveita ProfileForm, SecurityPanel e AppearancePanel, sem rota nova de API.
// /seguranca redireciona para cá e o grupo "Conta" saiu das Configurações.

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { PageBody } from "@/components/ddm/page-toolbar";
import { Skeleton } from "@/components/ddm/states";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProfileForm } from "@/components/settings/profile-form";
import { PanelHeadingLevel } from "@/components/settings/settings-panel-head";
import { SecurityPanel } from "@/components/settings/security-panel";
import { AppearancePanel } from "@/components/settings/appearance-panel";
import { PushSettingsCard } from "@/components/push/push-settings-card";

const TABS = ["perfil", "seguranca", "aparencia"] as const;
type ProfileTab = (typeof TABS)[number];

function resolveTab(raw: string | null): ProfileTab {
  return (TABS as readonly string[]).includes(raw ?? "") ? (raw as ProfileTab) : "perfil";
}

const TAB_CLASS =
  "flex-none px-0 pb-2.5 pt-1 text-[13px] data-active:text-foreground after:bg-primary after:!bottom-[-1px]";

function PerfilContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = resolveTab(searchParams.get("tab"));

  return (
    <PageBody className="gap-6">
      <div className="flex flex-col gap-1.5 pt-1">
        <h2 className="font-heading text-[28px] font-semibold leading-tight tracking-[-0.025em] text-foreground">Meu perfil</h2>
        <p className="max-w-[620px] text-sm leading-relaxed text-muted-foreground">
          Suas informações pessoais, segurança, notificações e aparência.
        </p>
      </div>

      <Tabs
        value={tab}
        onValueChange={(next) => {
          const params = new URLSearchParams(searchParams.toString());
          params.set("tab", String(next));
          router.replace(`/perfil?${params.toString()}`, { scroll: false });
        }}
      >
        <div className="border-b">
          <TabsList variant="line" className="h-auto justify-start gap-5 p-0">
            <TabsTrigger value="perfil" className={TAB_CLASS}>
              Perfil
            </TabsTrigger>
            <TabsTrigger value="seguranca" className={TAB_CLASS}>
              Segurança
            </TabsTrigger>
            <TabsTrigger value="aparencia" className={TAB_CLASS}>
              Aparência
            </TabsTrigger>
          </TabsList>
        </div>

        <PanelHeadingLevel level={3}>
          <TabsContent value="perfil" className="animate-ddm-fade pt-5">
            <div className="grid items-start gap-6 lg:grid-cols-2">
              <ProfileForm />
              <PushSettingsCard />
            </div>
          </TabsContent>
          <TabsContent value="seguranca" className="animate-ddm-fade pt-5">
            <div className="max-w-3xl">
              <SecurityPanel />
            </div>
          </TabsContent>
          <TabsContent value="aparencia" className="animate-ddm-fade pt-5">
            <div className="max-w-3xl">
              <AppearancePanel />
            </div>
          </TabsContent>
        </PanelHeadingLevel>
      </Tabs>
    </PageBody>
  );
}

export default function PerfilPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full rounded-[10px]" />}>
      <PerfilContent />
    </Suspense>
  );
}

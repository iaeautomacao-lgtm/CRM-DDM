"use client";

// Moldura das telas de acesso (login, recuperar/redefinir senha, convite, verificação em duas etapas) no visual do
// protótipo DDM: painel de marca escuro à esquerda (some abaixo de 900px) e o cartão do formulário à direita.
// Compartilhado com o Farol (passo /login/2fa) — combine antes de mudar a API. Sem texto de marketing fixo: o
// painel mostra só a marca; `brandTitle`/`brandText` existem para quando a operação definir o texto.

import Image from "next/image";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { OmniDdmLogo } from "@/components/ui/omniddm-logo";
import { cn } from "@/lib/utils";

export function AuthShell({
  title,
  description,
  notice,
  children,
  footer,
  icon,
  brandTitle,
  brandText,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Aviso acima do formulário (ex.: "Senha redefinida", erro geral). Use <AuthNotice>. */
  notice?: ReactNode;
  children: ReactNode;
  /** Linha abaixo do formulário (ex.: "Lembrou a senha? Entrar"). */
  footer?: ReactNode;
  /** Ícone no lugar do logo do topo no celular (ex.: convite). */
  icon?: ReactNode;
  brandTitle?: ReactNode;
  brandText?: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh bg-background text-foreground">
      <aside
        aria-hidden={brandTitle || brandText ? undefined : true}
        className="hidden flex-[1_1_46%] flex-col justify-between bg-[#0E1013] px-12 py-10 text-[#ECEDEE] min-[900px]:flex"
      >
        <Image src="/brand/omniddm.svg" alt="OmniDDM" width={132} height={26} className="h-[26px] w-auto self-start" priority />
        {(brandTitle || brandText) && (
          <div className="flex max-w-[440px] flex-col gap-3.5">
            {brandTitle && (
              <h1 className="m-0 font-heading text-[34px] font-semibold leading-[1.15] tracking-[-0.02em]">{brandTitle}</h1>
            )}
            {brandText && <p className="m-0 text-[15px] leading-relaxed text-[#B4B9C0]">{brandText}</p>}
          </div>
        )}
        <p className="m-0 text-[12.5px] text-[#8E949D]">© {new Date().getFullYear()} Grupo DDM</p>
      </aside>
      <main className="flex flex-[1_1_54%] items-center justify-center px-5 py-8">
        <div className="flex w-full max-w-[380px] animate-ddm-up flex-col gap-[22px]">
          <div className="min-[900px]:hidden">{icon ?? <OmniDdmLogo className="w-[120px]" priority />}</div>
          {icon && <div className="hidden min-[900px]:block">{icon}</div>}
          <div className="flex flex-col gap-1.5">
            <h2 className="m-0 font-heading text-2xl font-semibold tracking-[-0.015em] text-foreground">{title}</h2>
            {description && <p className="m-0 text-sm leading-relaxed text-foreground-2">{description}</p>}
          </div>
          {notice}
          {children}
          {footer && <div className="text-center text-[13.5px] text-foreground-2">{footer}</div>}
        </div>
      </main>
    </div>
  );
}

/** Aviso do topo do formulário: `ok` (sucesso), `bad` (erro geral, role=alert) ou `info`. */
export function AuthNotice({ tone = "info", id, children }: { tone?: "ok" | "bad" | "info"; id?: string; children: ReactNode }) {
  return (
    <div
      id={id}
      role={tone === "bad" ? "alert" : "status"}
      className={cn(
        "animate-ddm-fade rounded-lg px-3.5 py-3 text-[13px] leading-normal text-foreground",
        tone === "ok" ? "bg-success-soft" : tone === "bad" ? "bg-danger-soft" : "bg-surface-3",
      )}
    >
      {children}
    </div>
  );
}

/** Erro de um campo (abaixo do input; ligue com aria-describedby). */
export function AuthFieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <span id={id} className="text-[12.5px] font-medium text-danger">
      {children}
    </span>
  );
}

/** Classes do campo de acesso (42px, raio 8, foco laranja) para usar no <Input>. */
export const AUTH_INPUT_CLASS =
  "h-[42px] rounded-lg bg-card px-3 text-sm focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-primary/20 aria-invalid:border-danger";

/** Classes do botão principal (44px, largura total). */
export const AUTH_SUBMIT_CLASS = "h-11 w-full rounded-lg text-sm font-semibold";

/** Link "Voltar para o login" do rodapé das telas de acesso. */
export function BackToLogin({ label = "Voltar para o login" }: { label?: string }) {
  return (
    <Link
      href="/login"
      className="inline-flex items-center gap-1.5 rounded-sm font-semibold text-primary-text hover:underline focus-visible:outline-2 focus-visible:outline-ring"
    >
      <ArrowLeft className="size-3.5" aria-hidden="true" />
      {label}
    </Link>
  );
}

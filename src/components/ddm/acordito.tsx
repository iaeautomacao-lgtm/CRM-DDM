import type { ReactNode } from "react";
import Image from "next/image";

import { cn } from "@/lib/utils";

/** Nome do copiloto interno do CRM. Os Agentes de IA (que falam com o cliente) NÃO usam este nome nem esta imagem. */
export const ACORDITO = "Acordito";

export const ACORDITO_AVATAR_SRC = "/brand/acordito/acordito-avatar.png";
export const ACORDITO_MASCOTE_SRC = "/brand/acordito/acordito-mascote.png";

// px do rosto (PNG de 96): o anel usa o acento da marca do Acordito (--acordito-accent, par claro/escuro).
const SIZES = { sm: 20, md: 28, lg: 40 } as const;
const MASCOTE = { w: 240, h: 326 } as const;

/** Rosto do Acordito (coruja de terno com crachá DDM) em círculo, com anel no acento da marca. */
export function AcorditoAvatar({
  size = "md",
  alt = "Acordito",
  className,
}: {
  size?: keyof typeof SIZES;
  /** Passe "" quando o nome já está escrito ao lado (evita ler "Acordito" duas vezes). */
  alt?: string;
  className?: string;
}) {
  const px = SIZES[size];
  return (
    <Image
      src={ACORDITO_AVATAR_SRC}
      alt={alt}
      width={px}
      height={px}
      // PNG pequeno e estático: dispensa o otimizador de imagens do Next.
      unoptimized
      className={cn("shrink-0 rounded-full bg-card object-cover ring-2 ring-acordito-accent", className)}
    />
  );
}

/** Avatar + nome (ou outro texto), para títulos de painéis do Acordito. */
export function AcorditoMark({ children = ACORDITO, size = "sm", className }: { children?: ReactNode; size?: keyof typeof SIZES; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 font-semibold text-foreground", className)}>
      <AcorditoAvatar size={size} alt="" />
      {children}
    </span>
  );
}

/** Mascote de corpo inteiro para estados vazios e avisos do Acordito. `width` em px (altura segue a proporção). */
export function AcorditoMascote({ width = 120, alt = "", className }: { width?: number; alt?: string; className?: string }) {
  return (
    <Image
      src={ACORDITO_MASCOTE_SRC}
      alt={alt}
      width={MASCOTE.w}
      height={MASCOTE.h}
      unoptimized
      style={{ width, height: "auto" }}
      className={cn("shrink-0 select-none", className)}
    />
  );
}

"use client";

import Image from "next/image";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";

interface OmniDdmLogoProps {
  className?: string;
  symbolOnly?: boolean;
  priority?: boolean;
}

export function OmniDdmLogo({
  className,
  symbolOnly = false,
  priority = false,
}: OmniDdmLogoProps) {
  const { mode } = useTheme();
  const src = mode === "light" ? "/brand/omniddm-light.svg" : "/brand/omniddm.svg";

  if (symbolOnly) {
    return (
      <span
        className={cn(
          "inline-flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden",
          className,
        )}
        aria-label="OmniDDM"
      >
        <Image
          src={src}
          alt=""
          width={545}
          height={122}
          priority={priority}
          className="h-[30px] w-[134px] max-w-none translate-x-[51px] object-contain"
        />
      </span>
    );
  }

  return (
    <Image
      src={src}
      alt="OmniDDM"
      width={545}
      height={122}
      priority={priority}
      className={cn("h-auto w-[132px]", className)}
    />
  );
}

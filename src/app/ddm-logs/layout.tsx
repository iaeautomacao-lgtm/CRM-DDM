import type { Metadata } from "next";
import { Poppins } from "next/font/google";

// Poppins carregada só nesta rota (não é a fonte global do app, que usa
// Inter via src/app/layout.tsx) — página deliberadamente standalone, sem
// depender do design system do (dashboard).
const poppins = Poppins({
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
});

// noindex — não é autenticação (a rota não tem nenhuma, de propósito),
// só evita que a URL "oculta" acabe indexada por um crawler.
export const metadata: Metadata = {
  title: "DDM Logs",
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

export default function DdmLogsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className={`${poppins.className} min-h-screen bg-[#1F1F1F] text-zinc-100`}>
      {children}
    </div>
  );
}

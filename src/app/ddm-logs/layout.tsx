import type { Metadata } from "next";

// noindex — não é autenticação (a rota não tem nenhuma, de propósito),
// só evita que a URL "oculta" acabe indexada por um crawler.
export const metadata: Metadata = {
  title: "Logs do sistema",
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
    <div className="min-h-screen bg-background text-foreground">
      {children}
    </div>
  );
}

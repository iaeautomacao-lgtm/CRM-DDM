import type { Metadata } from "next";

// noindex: evita que a URL acabe indexada por um crawler. A página não tem gate próprio;
// quem protege os dados é /api/ddm-logs (admin com audit.view). Fica fora do menu lateral
// (só no Ctrl+K, com audit.view).
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

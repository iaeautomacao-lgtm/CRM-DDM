import { DisparadorTabs } from "@/components/disparador/disparador-tabs";

// Abas fixas em todas as telas de /disparador/* (Campanhas · Monitor · Desempenho · Erros).
export default function DisparadorLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-col">
      <DisparadorTabs />
      {children}
    </div>
  );
}

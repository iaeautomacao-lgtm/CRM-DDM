import { PageBody } from "@/components/ddm/page-toolbar";
import { Skeleton } from "@/components/ddm/states";

// Ao trocar de tela dentro do painel, o menu e o cabeçalho ficam e só o miolo mostra este esqueleto (antes aparecia o "Carregando…" de
// tela cheia do app, que escondia o menu). Vale para todas as telas do painel que não definem o próprio esqueleto.
export default function DashboardLoading() {
  return (
    <PageBody aria-busy="true" aria-label="Carregando a tela">
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-8 w-56 rounded-field" />
        <Skeleton className="h-9 w-32 rounded-field" />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full rounded-card" />
        ))}
      </div>
      <Skeleton className="h-72 w-full rounded-card" />
    </PageBody>
  );
}

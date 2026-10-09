import { PageBody } from "@/components/ddm/page-toolbar";
import { ReportTabs } from "@/components/relatorios/report-tabs";

export default function ReportsLayout({ children }: { children: React.ReactNode }) {
  return (
    <PageBody className="gap-4">
      <div className="flex flex-col gap-1.5 pt-1">
        <h2 className="font-heading text-[28px] font-semibold leading-tight tracking-[-0.025em] text-foreground">Relatórios</h2>
        <p className="max-w-[620px] text-sm leading-relaxed text-muted-foreground">
          Atendimento, conversas, campanhas e auditoria da operação, por período.
        </p>
      </div>
      <ReportTabs />
      <div className="animate-ddm-fade">{children}</div>
    </PageBody>
  );
}

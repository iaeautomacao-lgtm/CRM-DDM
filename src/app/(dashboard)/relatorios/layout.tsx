import { PageBody } from "@/components/ddm/page-toolbar";
import { ReportTabs } from "@/components/relatorios/report-tabs";
import { PageHeader } from "@/components/ddm/page-header";

export default function ReportsLayout({ children }: { children: React.ReactNode }) {
  return (
    <PageBody className="gap-4">
      <PageHeader>Atendimento, conversas, campanhas e auditoria da operação, por período.</PageHeader>
      <ReportTabs />
      <div className="animate-ddm-fade">{children}</div>
    </PageBody>
  );
}

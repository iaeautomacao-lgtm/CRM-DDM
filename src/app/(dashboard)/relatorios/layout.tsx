import { ReportTabs } from "@/components/relatorios/report-tabs";

export default function ReportsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-col">
      <ReportTabs />
      {children}
    </div>
  );
}

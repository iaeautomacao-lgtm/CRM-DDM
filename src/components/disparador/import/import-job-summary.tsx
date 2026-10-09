import { AlertTriangle } from "lucide-react";
import type { PublicImportJob } from "@/lib/disparador/import-client";

/**
 * Totais do job (os mesmos números que a importação síncrona dava) e o erro por linha que o servidor guardou
 * (até 200 mensagens). `variaveis_falhas > 0` = reimportar antes de iniciar uma campanha que use VAR1–VAR3.
 */
export function ImportJobSummary({ job }: { job: PublicImportJob }) {
  const t = job.totals;
  const cells = [
    { label: "Importados", value: t.importados },
    { label: "Duplicados", value: t.duplicados },
    { label: "Inválidos", value: t.invalidos },
    { label: "Na blacklist", value: t.blacklisted },
    { label: "Vinculados à lista", value: job.linked },
  ];
  return (
    <div className="flex flex-col gap-3">
      <dl className="m-0 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3">
        {cells.map((c) => (
          <div key={c.label} className="bg-card px-3 py-2.5">
            <dt className="text-xs text-foreground-2">{c.label}</dt>
            <dd className="m-0 text-base font-semibold tabular-nums text-foreground">{c.value.toLocaleString("pt-BR")}</dd>
          </div>
        ))}
      </dl>
      {t.variaveis_falhas > 0 && (
        <p className="m-0 flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2 text-xs text-foreground">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />
          {t.variaveis_falhas.toLocaleString("pt-BR")} contato(s) ficaram sem as variáveis VAR1–VAR3. Reimporte antes de iniciar uma
          campanha que use essas variáveis.
        </p>
      )}
      {job.error && (
        <p role="alert" className="m-0 flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-xs text-foreground">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden="true" />
          {job.error}
        </p>
      )}
      {job.errors.length > 0 && (
        <div>
          <p className="m-0 mb-1.5 text-xs font-semibold text-foreground-2">
            Erros por linha ({job.errors.length.toLocaleString("pt-BR")}
            {job.errors.length >= 200 ? ", mostrando os primeiros 200" : ""})
          </p>
          <ul className="m-0 max-h-56 list-none overflow-y-auto rounded-lg border border-border p-0 text-xs">
            {job.errors.map((e, i) => (
              <li key={i} className="border-b border-border px-3 py-1.5 font-mono text-[11.5px] text-foreground-2 last:border-b-0">
                {e}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

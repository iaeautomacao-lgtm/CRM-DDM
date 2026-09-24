import Link from "next/link";
import { Home } from "lucide-react";

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-[#FF5706]/10">
          <Home className="h-8 w-8 text-[#FF5706]" />
        </div>

        <p className="text-xs font-medium uppercase tracking-[0.18em] text-[#FF5706]">
          404
        </p>
        <h1 className="mt-2 text-2xl font-semibold text-foreground">
          Página não encontrada
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          A rota acessada não existe ou foi movida. Você pode voltar ao início do CRM.
        </p>

        <Link
          href="/"
          className="mt-6 inline-flex w-full items-center justify-center rounded-md bg-[#FF5706] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#FF5706]/90"
        >
          Voltar ao início
        </Link>
      </div>
    </div>
  );
}

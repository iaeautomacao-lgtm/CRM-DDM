import Link from "next/link";
import { Search } from "lucide-react";

import { ErrorScreen } from "@/components/errors/error-screen";
import { buttonVariants } from "@/components/ui/button";

export default function NotFound() {
  return (
    <ErrorScreen
      fullScreen
      code="404"
      icon={Search}
      title="Página não encontrada"
      description="A rota acessada não existe ou foi movida. Você pode voltar ao início do CRM."
      actions={
        <Link href="/" className={buttonVariants()}>
          Voltar ao início
        </Link>
      }
    />
  );
}

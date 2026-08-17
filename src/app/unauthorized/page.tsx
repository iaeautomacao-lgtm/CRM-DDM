import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function UnauthorizedPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-red-500/10">
            <ShieldAlert className="h-6 w-6 text-red-400" />
          </div>
          <CardTitle className="text-xl text-foreground">
            Acesso não autorizado
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            Você não tem permissão para acessar esta página.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            className="w-full"
            render={<Link href="/dashboard">Voltar para o Dashboard</Link>}
          />
        </CardContent>
      </Card>
    </div>
  );
}

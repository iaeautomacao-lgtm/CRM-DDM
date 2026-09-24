import { Loader2 } from "lucide-react";

export default function Loading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[#FF5706]/10">
          <Loader2 className="h-8 w-8 animate-spin text-[#FF5706]" />
        </div>
        <p className="text-sm font-medium text-foreground">Carregando...</p>
      </div>
    </div>
  );
}

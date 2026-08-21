import { apiFetch } from "@/lib/api-fetch";
"use client";

import { useState } from "react";
import { 
  ArrowLeft, 
  Upload, 
  Download, 
  CheckCircle2, 
  AlertTriangle, 
  AlertCircle,
  Loader2,
  FileSpreadsheet,
  Users
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface ImportResults {
  importados: number;
  duplicados: number;
  invalidos: number;
  blacklisted: number;
  erros: string[];
}

export default function ImportarContatosPage() {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [results, setResults] = useState<ImportResults | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      setResults(null);
    }
  };

  const handleUpload = async () => {
    if (!file) {
      toast.error("Por favor, selecione um arquivo.");
      return;
    }

    setUploading(true);
    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await apiFetch("/api/disparador/contacts/import", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Erro ao processar importação.");
      }

      const data = await res.json();
      setResults(data.results);
      toast.success("Importação concluída com sucesso!");
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col space-y-6 p-4 lg:p-6 overflow-hidden">
      {/* Header */}
      <div className="flex flex-col gap-4 border-b border-border/40 pb-4 sm:flex-row sm:items-center">
        <Link href="/disparador">
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
            Importar Contatos
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Envie planilhas CSV ou XLSX para cadastrar contatos em lote na base do disparador.
          </p>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-6 items-start overflow-y-auto pr-2">
        {/* Upload Card */}
        <div className="rounded-xl border border-border bg-card p-6 space-y-6 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileSpreadsheet className="h-5 w-5 text-primary" />
              <h3 className="font-semibold text-foreground">Planilha de Contatos</h3>
            </div>
            <a href="/modelo_importacao_disparador.csv" download>
              <Button variant="outline" size="sm" className="gap-1.5 text-xs h-8">
                <Download className="h-3.5 w-3.5" /> Baixar Modelo
              </Button>
            </a>
          </div>

          <div className="border-2 border-dashed border-border rounded-xl p-8 flex flex-col items-center justify-center text-center space-y-3 bg-muted/10">
            <Upload className="h-8 w-8 text-zinc-400" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">
                Selecione o arquivo de contatos
              </p>
              <p className="text-xs text-muted-foreground">
                Formatos aceitos: .csv ou .xlsx (Excel)
              </p>
            </div>
            <input 
              type="file" 
              accept=".csv,.xlsx,.xls"
              onChange={handleFileChange}
              className="hidden" 
              id="file-upload"
            />
            <label 
               htmlFor="file-upload" 
               className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80 h-9 px-3 cursor-pointer"
             >
               Escolher Arquivo
             </label>
            {file && (
              <span className="text-xs font-mono bg-zinc-100 dark:bg-zinc-800 px-2.5 py-1 rounded text-zinc-600 dark:text-zinc-400">
                {file.name}
              </span>
            )}
          </div>

          <Button 
            onClick={handleUpload} 
            disabled={!file || uploading} 
            className="w-full gap-2 h-10"
          >
            {uploading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Processando...
              </>
            ) : (
              <>
                Começar Importação
              </>
            )}
          </Button>
        </div>

        {/* Results Card */}
        {results && (
          <div className="rounded-xl border border-border bg-card p-6 space-y-6 shadow-sm">
            <div className="flex items-center justify-between gap-4">
              <h3 className="font-semibold text-foreground">Resumo da Importação</h3>
              <Link href="/contacts">
                <Button variant="outline" size="sm" className="gap-1.5 text-xs h-8">
                  <Users className="h-3.5 w-3.5" /> Ver Contatos
                </Button>
              </Link>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-lg border border-border p-3.5 space-y-1.5 bg-emerald-500/5">
                <span className="text-[10px] font-bold text-emerald-500 uppercase">Importados</span>
                <div className="flex items-baseline justify-between">
                  <span className="text-xl font-bold text-emerald-500">{results.importados}</span>
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                </div>
              </div>

              <div className="rounded-lg border border-border p-3.5 space-y-1.5 bg-amber-500/5">
                <span className="text-[10px] font-bold text-amber-500 uppercase">Duplicados</span>
                <div className="flex items-baseline justify-between">
                  <span className="text-xl font-bold text-amber-500">{results.duplicados}</span>
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                </div>
              </div>

              <div className="rounded-lg border border-border p-3.5 space-y-1.5 bg-zinc-500/5">
                <span className="text-[10px] font-bold text-zinc-500 uppercase">Inválidos</span>
                <div className="flex items-baseline justify-between">
                  <span className="text-xl font-bold text-zinc-500">{results.invalidos}</span>
                  <AlertCircle className="h-4 w-4 text-zinc-500" />
                </div>
              </div>

              <div className="rounded-lg border border-border p-3.5 space-y-1.5 bg-red-500/5">
                <span className="text-[10px] font-bold text-red-500 uppercase">Na Blacklist</span>
                <div className="flex items-baseline justify-between">
                  <span className="text-xl font-bold text-red-500">{results.blacklisted}</span>
                  <AlertCircle className="h-4 w-4 text-red-500" />
                </div>
              </div>
            </div>

            {results.erros.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-foreground">Erros Detalhados:</h4>
                <div className="max-h-40 overflow-y-auto rounded-lg border border-border bg-muted/20 p-3 font-mono text-[10px] space-y-1 text-red-500">
                  {results.erros.map((err, idx) => (
                    <div key={idx}>{err}</div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

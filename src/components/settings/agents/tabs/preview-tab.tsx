import { useState } from 'react';
import { Eye, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface PreviewTabProps {
  onPreview: () => Promise<string>;
  readOnly?: boolean;
}

export function PreviewTab({ onPreview, readOnly }: PreviewTabProps) {
  const [loading, setLoading] = useState(false);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handlePreview() {
    setLoading(true);
    setError(null);
    try {
      setPrompt(await onPreview());
    } catch (err) {
      setPrompt(null);
      setError(err instanceof Error && err.message ? err.message : 'Não foi possível gerar a prévia.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">Prévia do prompt</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            A prévia usa os valores atuais do formulário (ainda não salvos).
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void handlePreview()} disabled={loading || readOnly} className="shrink-0">
          {loading ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : <Eye className="size-3.5 mr-1.5" />}
          Gerar prévia
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {prompt !== null && (
        <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/30 p-4 text-xs leading-relaxed">
          {prompt || 'O prompt composto está vazio.'}
        </pre>
      )}
    </div>
  );
}

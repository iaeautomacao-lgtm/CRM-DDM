'use client';

// Configurações → Documentação da API: atalho para a página pública /docs/api (guia + referência),
// a mesma que se manda para quem vai integrar. Abre em nova aba.

import { BookOpen, ExternalLink, ListTree } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';

export function ApiDocsPanel() {
  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title="Documentação da API"
        description="Guia passo a passo e referência completa da API pública (/api/v1): disparar campanhas, envio avulso e relatórios. A página é pública — pode mandar o link para quem vai integrar."
        action={
          <a
            href="/docs/api"
            target="_blank"
            rel="noreferrer"
            className="bg-primary text-primary-foreground inline-flex h-9 items-center gap-2 rounded-md px-4 text-sm font-medium hover:opacity-90"
          >
            <ExternalLink className="size-4" />
            Abrir documentação
          </a>
        }
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <CardContent className="flex gap-3 py-4">
            <BookOpen className="text-primary mt-0.5 size-5 shrink-0" />
            <div>
              <p className="text-sm font-semibold">Guia</p>
              <p className="text-muted-foreground mt-1 text-sm">
                Como pedir a chave, disparar campanha (Meta × WAHA), acompanhar, envio avulso, relatórios e erros — com exemplos em curl, JavaScript e n8n.
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex gap-3 py-4">
            <ListTree className="text-primary mt-0.5 size-5 shrink-0" />
            <div>
              <p className="text-sm font-semibold">Referência</p>
              <p className="text-muted-foreground mt-1 text-sm">
                Todos os endpoints, campos e exemplos de resposta, gerados da especificação OpenAPI (<code className="text-xs">/api/v1/openapi.json</code>).
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
      <p className="text-muted-foreground text-sm">
        As chaves de API são criadas em <strong>Chaves de API</strong> (só admin cria).
      </p>
    </section>
  );
}

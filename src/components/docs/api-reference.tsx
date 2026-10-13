// Referência da API: um grupo por tag da spec e uma rota por bloco (método, caminho, escopo, parâmetros,
// corpo, respostas com exemplo e snippets). Renderizada direto da spec (docs-reference.ts), sem script externo
// e sem envio de requisições reais pelo navegador. Sem hooks: só RouteExamples/CodeBlock/CopyButton são client.

import type { ReactNode } from 'react';
import { Link2 } from 'lucide-react';

import { StatusChip, type StatusTone } from '@/components/ddm/status-chip';
import type { FieldRow, GroupModel, OperationModel, ParamRow, ResponseRow } from '@/lib/api/v1/docs-reference';
import { CodeBlock, RouteExamples } from './code-tabs';
import { Inline, Markdown } from './docs-markdown';

const METHOD_TONE: Record<string, StatusTone> = { GET: 'info', POST: 'ok', PUT: 'warn', PATCH: 'warn', DELETE: 'bad' };

function statusTone(status: string): StatusTone {
  if (status.startsWith('2')) return 'ok';
  if (status.startsWith('4')) return 'warn';
  return 'bad';
}

export function MethodBadge({ method }: { method: string }) {
  return (
    <StatusChip tone={METHOD_TONE[method] ?? 'mute'} dot={false} className="font-mono">
      {method}
    </StatusChip>
  );
}

function SubTitle({ children }: { children: ReactNode }) {
  return <h4 className="font-heading text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</h4>;
}

function FieldTable({ rows, showIn }: { rows: Array<FieldRow | ParamRow>; showIn?: boolean }) {
  return (
    <div className="overflow-x-auto rounded-field border border-border">
      <table className="w-full min-w-[30rem] text-left text-sm">
        <thead className="bg-surface-3 text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-semibold">Campo</th>
            {showIn && <th className="px-3 py-2 font-semibold">Onde</th>}
            <th className="px-3 py-2 font-semibold">Tipo</th>
            <th className="px-3 py-2 font-semibold">Descrição</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={`${'in' in r ? r.in : ''}${r.name}`} className="align-top">
              <td className="px-3 py-2.5">
                <code className="font-mono text-[12.5px] font-semibold text-foreground">{r.name}</code>
                {r.required && <span className="ml-1.5 text-xs font-semibold text-danger">obrigatório</span>}
              </td>
              {showIn && <td className="px-3 py-2.5 text-foreground-2">{'in' in r ? { path: 'caminho', query: 'query', header: 'header' }[r.in] : ''}</td>}
              <td className="px-3 py-2.5 font-mono text-xs text-foreground-2">{r.type}</td>
              <td className="px-3 py-2.5 text-foreground-2">
                {r.description ? <Inline text={r.description} /> : '—'}
                {'example' in r && r.example ? (
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Exemplo: <code className="font-mono">{r.example}</code>
                  </span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResponseItem({ response }: { response: ResponseRow }) {
  const success = response.status.startsWith('2');
  const hasDetail = response.examples.length > 0 || response.fields.length > 0;
  return (
    <details open={success} className="group rounded-field border border-border bg-card">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <StatusChip tone={statusTone(response.status)} dot={false} className="font-mono">
          {response.status}
        </StatusChip>
        <span className="min-w-0 flex-1 text-foreground-2">
          <Inline text={response.description} />
        </span>
        {hasDetail && <span className="text-xs font-semibold text-primary-text group-open:hidden">Ver exemplo</span>}
      </summary>
      {hasDetail && (
        <div className="space-y-3 border-t border-border p-3">
          {response.examples.map((e, i) => (
            <CodeBlock key={i} code={e.json} label={e.label ?? 'Exemplo de resposta'} />
          ))}
          {response.fields.length > 0 && <FieldTable rows={response.fields} />}
        </div>
      )}
    </details>
  );
}

export function RouteBlock({ op }: { op: OperationModel }) {
  const pathParams = op.params.filter((p) => p.in === 'path');
  const queryParams = op.params.filter((p) => p.in === 'query');
  const headerParams = op.params.filter((p) => p.in === 'header');
  return (
    <article id={op.id} className="scroll-mt-24 rounded-card border border-border bg-card p-5 shadow-sm sm:p-6">
      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <MethodBadge method={op.method} />
          <code className="min-w-0 break-all font-mono text-[14px] font-semibold text-foreground">{op.path}</code>
          <a
            href={`#${op.id}`}
            aria-label={`Link direto para ${op.method} ${op.path}`}
            className="ml-auto inline-flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <Link2 className="size-4" />
          </a>
        </div>
        <h3 className="font-heading text-lg font-semibold tracking-[-0.01em] text-foreground">{op.summary}</h3>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-semibold">Escopo:</span>
          {op.scopes.length === 0 ? (
            <StatusChip tone="mute" dot={false}>
              nenhum
            </StatusChip>
          ) : (
            op.scopes.map((s, i) => (
              <span key={s} className="inline-flex items-center gap-1.5">
                {i > 0 && <span>ou</span>}
                <StatusChip tone="brand" dot={false} className="font-mono">
                  {s}
                </StatusChip>
              </span>
            ))
          )}
        </div>
      </header>

      <div className="mt-5 grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-5">
          {op.description && <Markdown source={op.description} />}

          {pathParams.length > 0 && (
            <div className="space-y-2">
              <SubTitle>Parâmetros do caminho</SubTitle>
              <FieldTable rows={pathParams} />
            </div>
          )}
          {headerParams.length > 0 && (
            <div className="space-y-2">
              <SubTitle>Headers</SubTitle>
              <FieldTable rows={headerParams} />
            </div>
          )}
          {queryParams.length > 0 && (
            <div className="space-y-2">
              <SubTitle>Parâmetros de query</SubTitle>
              <FieldTable rows={queryParams} />
            </div>
          )}
          {op.body && (
            <div className="space-y-2">
              <SubTitle>Corpo da requisição (JSON)</SubTitle>
              {op.body.description && <Markdown source={op.body.description} />}
              {op.body.fields.length > 0 && <FieldTable rows={op.body.fields} />}
            </div>
          )}
        </div>

        <div className="min-w-0 space-y-5">
          <div className="space-y-2">
            <SubTitle>Exemplo de requisição</SubTitle>
            <RouteExamples sets={op.snippetSets} title={`Exemplo de ${op.method} ${op.path}`} />
          </div>
          <div className="space-y-2">
            <SubTitle>Respostas e erros</SubTitle>
            <div className="space-y-2">
              {op.responses.map((r) => (
                <ResponseItem key={r.status} response={r} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}

export function ReferenceGroup({ group, notes }: { group: GroupModel; notes?: ReactNode }) {
  return (
    <section id={group.id} aria-labelledby={`${group.id}-titulo`} className="scroll-mt-24 space-y-5">
      <div className="space-y-2">
        <h2 id={`${group.id}-titulo`} className="font-heading text-[26px] font-semibold leading-tight tracking-[-0.025em] text-foreground">
          {group.name}
        </h2>
        {group.description && <p className="max-w-[68ch] text-sm leading-relaxed text-foreground-2">{group.description}</p>}
      </div>
      {notes}
      <div className="space-y-5">
        {group.operations.map((op) => (
          <RouteBlock key={op.id} op={op} />
        ))}
      </div>
    </section>
  );
}

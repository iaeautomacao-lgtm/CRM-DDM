// Guia da API (português, curto e direto). Sem hooks: renderiza no servidor; só CodeTabs/CodeBlock são client.

import type { ReactNode } from 'react';

import { ERROR_ROWS, GUIDE_SECTIONS, SCOPE_ROWS, type GuideExamples } from '@/lib/api/v1/docs-guide';
import { CodeBlock, CodeTabs } from './code-tabs';

function Section({ id, title, intro, children }: { id: string; title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 space-y-4 border-b border-border pb-10 last:border-0">
      <h2 className="text-2xl font-bold tracking-tight text-foreground">{title}</h2>
      {intro ? <p className="max-w-[68ch] text-base text-muted-foreground">{intro}</p> : null}
      {children}
    </section>
  );
}

const H3 = ({ children }: { children: ReactNode }) => <h3 className="pt-2 text-lg font-semibold text-foreground">{children}</h3>;
const P = ({ children }: { children: ReactNode }) => <p className="max-w-[68ch] text-sm leading-relaxed text-foreground/90">{children}</p>;
const C = ({ children }: { children: ReactNode }) => (
  <code className="rounded bg-muted px-1.5 py-0.5 text-[0.8em] font-medium text-foreground">{children}</code>
);

function Callout({ tone = 'info', title, children }: { tone?: 'info' | 'warn'; title: string; children: ReactNode }) {
  return (
    <div
      className={
        tone === 'warn'
          ? 'rounded-lg border border-amber-500/40 bg-amber-500/10 p-4'
          : 'rounded-lg border border-primary/30 bg-primary/5 p-4'
      }
    >
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <div className="mt-1 space-y-1 text-sm text-foreground/90">{children}</div>
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[34rem] text-left text-sm">
        <thead className="bg-muted/60 text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-3 py-2 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row, i) => (
            <tr key={i} className="align-top">
              {row.map((cell, j) => (
                <td key={j} className="px-3 py-2.5">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function GuideNav({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Seções do guia" className="space-y-1">
      {GUIDE_SECTIONS.map((s, i) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          onClick={onNavigate}
          className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            {i + 1}
          </span>
          {s.title}
        </a>
      ))}
    </nav>
  );
}

export function ApiGuide({ examples }: { examples: GuideExamples }) {
  const { snippets, baseUrl } = examples;
  return (
    <div className="space-y-10">
      {/* 1 ─ Comece aqui */}
      <Section
        id="comece"
        title="Comece aqui"
        intro="A API pública deixa o seu sistema (planejamento de cobrança, n8n, BI) falar com o CRM sem abrir o painel: disparar campanhas, mandar mensagens avulsas, acompanhar resultados e puxar relatórios."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            ['Disparar campanha', 'Mande milhares de contatos de uma vez, pelo canal Meta (template) ou WAHA (texto livre).'],
            ['Acompanhar', 'Consulte status, enviadas, entregues, lidas e erros da campanha.'],
            ['Envio avulso', 'Uma mensagem para um telefone (aviso, confirmação, boleto).'],
            ['Relatórios', 'Números agregados de atendimento para Power BI, Metabase ou n8n.'],
          ].map(([t, d]) => (
            <div key={t} className="rounded-lg border border-border bg-card p-4">
              <p className="text-sm font-semibold text-foreground">{t}</p>
              <p className="mt-1 text-sm text-muted-foreground">{d}</p>
            </div>
          ))}
        </div>

        <H3>1. URL base</H3>
        <P>
          Todas as rotas começam por esta URL (a mesma do CRM, mais <C>/api/v1</C>):
        </P>
        <CodeBlock code={baseUrl} label="URL base" />

        <H3>2. Peça a sua chave</H3>
        <ol className="max-w-[68ch] list-decimal space-y-1 pl-5 text-sm text-foreground/90">
          <li>
            No CRM, abra <strong>Configurações → Chaves de API</strong>.
          </li>
          <li>
            Só quem é <strong>admin</strong> (ou dono da conta) cria chaves: peça a essa pessoa se o botão não aparecer.
          </li>
          <li>Marque só os escopos de que precisa (tabela abaixo) e crie.</li>
          <li>
            <strong>Copie a chave na hora:</strong> ela aparece uma única vez e começa com <C>wacrm_live_</C>. Guarde num cofre/variável de ambiente — nunca em código
            público.
          </li>
        </ol>
        <Callout tone="warn" title="A chave é da conta">
          <p>Ela só age na conta em que foi criada. Se vazar, revogue em Configurações → Chaves de API e crie outra.</p>
        </Callout>

        <H3>3. Escopos: o que cada chave pode fazer</H3>
        <Table
          head={['Escopo', 'Serve para', 'Rotas']}
          rows={SCOPE_ROWS.map((r) => [<C key="s">{r.scope}</C>, r.paraQue, <C key="e">{r.endpoints}</C>])}
        />
        <P>
          Exemplo: para <strong>disparar campanha</strong> a chave precisa de <C>campaigns:write</C>.
        </P>

        <H3>4. Primeiro teste: “quem sou eu?”</H3>
        <P>
          Troque <C>SUA_CHAVE_DE_API</C> pela sua chave. Se voltar o nome da conta, está tudo certo.
        </P>
        <CodeTabs snippets={snippets.me} title="Primeiro teste" />
        <P>
          Resposta de sucesso: <C>{'{ "data": { "account": …, "key": { "scopes": […] } } }'}</C>. Toda resposta vem em <C>data</C> (sucesso) ou em <C>error</C> (falha).
        </P>
      </Section>

      {/* 2 ─ Campanha */}
      <Section
        id="campanha"
        title="Disparar campanha (Meta × WAHA)"
        intro={
          <>
            Uma só rota — <C>POST /disparador/campaigns</C> — para os dois tipos de canal. A diferença está no que você manda para cada um. A campanha entra na fila na hora e o CRM
            envia dentro da janela de horário.
          </>
        }
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-primary px-2.5 py-0.5 text-xs font-semibold text-primary-foreground">Meta</span>
              <p className="text-sm font-semibold text-foreground">Canal oficial (WhatsApp Cloud API)</p>
            </div>
            <ul className="list-disc space-y-1 pl-5 text-sm text-foreground/90">
              <li>
                Envie <C>template_name</C>: o nome de um template <strong>já aprovado</strong> na WABA do canal.
              </li>
              <li>
                <C>variables</C> de cada contato vão como parâmetros do template — <strong>a Meta faz a substituição</strong> do <C>{'{{1}}'}</C>, <C>{'{{2}}'}</C>…
              </li>
              <li>
                <C>channel</C>: UUID do canal ou o número do canal Meta (ex.: <C>+55 21 3030-9159</C>).
              </li>
            </ul>
            <CodeBlock code={examples.payloadMeta} label="Corpo (JSON) — Meta" />
            <CodeTabs snippets={snippets.campanhaMeta} title="Chamada completa — Meta" />
          </div>

          <div className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-secondary px-2.5 py-0.5 text-xs font-semibold text-secondary-foreground">WAHA</span>
              <p className="text-sm font-semibold text-foreground">Canal WAHA (texto livre)</p>
            </div>
            <ul className="list-disc space-y-1 pl-5 text-sm text-foreground/90">
              <li>
                Envie <C>message</C>: texto livre com <C>{'{{1}}'}</C>, <C>{'{{2}}'}</C>… <strong>O CRM substitui</strong> pelos valores de <C>variables</C> de cada contato.
              </li>
              <li>Não existe template aprovado: não mande <C>template_name</C>.</li>
              <li>
                <C>channel</C>: só o <strong>UUID</strong> do canal (WAHA não aceita número).
              </li>
              <li>
                Se faltar valor para um <C>{'{{n}}'}</C>, o contato vai para <C>invalid</C> com motivo <C>missing_variable</C>.
              </li>
            </ul>
            <CodeBlock code={examples.payloadWaha} label="Corpo (JSON) — WAHA" />
            <CodeTabs snippets={snippets.campanhaWaha} title="Chamada completa — WAHA" />
          </div>
        </div>

        <Callout title="Não misture os dois">
          <p>
            Meta usa <C>template_name</C> + <C>variables</C> (a Meta substitui). WAHA usa <C>message</C> + <C>variables</C> (o CRM substitui). Mandar o campo do outro tipo gera erro 400.
          </p>
        </Callout>

        <H3>O que a resposta traz</H3>
        <Table
          head={['Campo', 'Significa']}
          rows={[
            [<C key="a">campaign_id</C>, 'Id da campanha — guarde para acompanhar.'],
            [<C key="b">enqueued</C>, 'Contatos que entraram na fila.'],
            [<C key="c">duplicates</C>, 'Números repetidos no mesmo envio (com/sem +55, com/sem o 9º dígito): vale o primeiro.'],
            [<C key="d">skipped</C>, 'Números na blacklist/opt-out (não recebem).'],
            [<C key="e">invalid</C>, 'Contatos rejeitados (sem telefone, telefone inválido, variável faltando…).'],
            [<C key="f">invalid_sample</C>, 'Até 20 exemplos do que foi rejeitado: posição (index), telefone e motivo.'],
            [<C key="g">slots</C>, 'Em quantos lotes o envio foi dividido (slot_size contatos a cada slot_interval_minutes).'],
            [<C key="h">estimated_completion_minutes</C>, 'Tempo de janela aberta até o último lote começar.'],
          ]}
        />
        <P>
          Se nenhum contato for válido, a resposta é <C>400</C> com os mesmos contadores — nada é criado.
        </P>

        <H3>Limites e agenda</H3>
        <ul className="max-w-[68ch] list-disc space-y-1 pl-5 text-sm text-foreground/90">
          <li>
            Até <strong>20.000 contatos por chamada</strong> (corpo de até 15 MB). Acima disso: <C>413</C> — divida em várias campanhas.
          </li>
          <li>
            O envio só acontece dentro da <strong>janela</strong> (<C>janela_inicio</C>–<C>janela_fim</C>, horário de Brasília; padrão 08:00–18:00) e nos <strong>dias permitidos</strong> (<C>dias_envio</C>;
            padrão segunda a sexta). Criou às 20h? Começa às 08h do próximo dia permitido, sem rajada.
          </li>
          <li>
            Números repetidos são unificados <strong>com e sem o 9º dígito</strong> e com ou sem +55.
          </li>
        </ul>

        <H3>Como evitar campanha duplicada</H3>
        <P>
          Se a sua chamada falhar por rede e você tentar de novo, pode criar duas campanhas. Evite mandando <C>external_id</C> no corpo (um id do seu sistema) <strong>ou</strong> o header{' '}
          <C>Idempotency-Key</C> (8–128 caracteres). Repetir com o mesmo conteúdo devolve a campanha que já existe (200); com outro conteúdo, <C>409</C>.
        </P>
      </Section>

      {/* 3 ─ Acompanhar */}
      <Section
        id="acompanhar"
        title="Acompanhar a campanha"
        intro={
          <>
            Use o <C>campaign_id</C> da criação em <C>GET /disparador/campaigns/{'{id}'}</C> (escopo <C>campaigns:read</C> ou <C>campaigns:write</C>).
          </>
        }
      >
        <CodeTabs snippets={snippets.acompanhar} title="Acompanhar campanha" />
        <Table
          head={['Campo', 'Significa']}
          rows={[
            [<C key="a">status</C>, <>Ex.: <C>em_execucao</C>, <C>pausada</C>, <C>encerrada</C>.</>],
            [<C key="b">metrics</C>, 'Total, enviadas, entregues, lidas, erros e pendentes.'],
            [<C key="c">queue</C>, 'Contagem por situação na fila: agendado, enviando, entregue, erro, cancelado.'],
            [<C key="d">window</C>, 'Janela de envio da campanha.'],
          ]}
        />
        <P>Consulte de tempos em tempos (por exemplo a cada minuto) — sem passar de 120 requisições por minuto. Campanha de outra conta devolve <C>404</C>.</P>
      </Section>

      {/* 4 ─ Avulso */}
      <Section
        id="avulso"
        title="Envio avulso"
        intro={
          <>
            <C>POST /whatsapp/send</C> manda uma mensagem (texto e/ou mídia) para um telefone, pelo canal habilitado da conta. Escopo <C>messages:send</C>.
          </>
        }
      >
        <CodeTabs snippets={snippets.avulso} title="Envio avulso" />
        <ul className="max-w-[68ch] list-disc space-y-1.5 pl-5 text-sm text-foreground/90">
          <li>
            <strong>
              <C>Idempotency-Key</C> é obrigatória
            </strong>{' '}
            (8–128 caracteres): uma por intenção de envio. Ao reenviar, use <strong>a mesma chave e o mesmo corpo</strong> — assim a mensagem nunca sai duas vezes.
          </li>
          <li>
            <strong>Blacklist:</strong> destinatário bloqueado/opt-out devolve <C>422 recipient_blocked</C> e nada é enviado.
          </li>
          <li>
            <strong>Mídia:</strong> envie <C>media_url</C> (link <C>https://</C> público) <em>ou</em> <C>media_base64</C> (+ <C>media_type</C>, até 16 MB). Tipos: JPEG, PNG, WebP, GIF, MP4, OGG, MP3 e PDF. A{' '}
            <C>media_caption</C> vale só para imagem/vídeo.
          </li>
          <li>
            <C>salvar_bd: false</C> envia sem registrar contato/conversa no CRM (notificação transacional).
          </li>
          <li>
            Resposta <C>202</C> com <C>reconciliation_required</C>: a mensagem saiu, só a gravação local falhou — <strong>não reenvie</strong>.
          </li>
        </ul>
        <Callout tone="warn" title="Janela de 24 horas da Meta">
          <p>
            Este endpoint manda texto livre, <strong>sem template</strong>. Em canal Meta, fora da janela de 24 h desde a última mensagem do cliente, a Meta recusa texto livre e você recebe erro
            do provedor (<C>502</C>). Para falar com quem não respondeu nas últimas 24 h, use uma <strong>campanha com template aprovado</strong>.
          </p>
        </Callout>
      </Section>

      {/* 5 ─ Relatórios */}
      <Section
        id="relatorios"
        title="Relatórios para BI"
        intro={
          <>
            Rotas <C>GET /reports/*</C> (escopo <C>reports:read</C>): só leitura e só números agregados — nunca mensagens, CPF ou credenciais. Ligue direto no Power BI, Metabase ou n8n.
          </>
        }
      >
        <Table
          head={['Rota', 'O que devolve', 'Filtros']}
          rows={[
            [<C key="1">GET /reports/operations/current</C>, 'Foto do atendimento agora: conversas por fase e operadores por presença.', <>team_id, agent_id</>],
            [<C key="2">GET /reports/operations/summary</C>, 'Métricas do período: recebidas, atendidas, encerradas, tabuladas, tempos médios.', <>from, to, team_id, agent_id</>],
            [<C key="3">GET /reports/teams</C>, 'Resumo por equipe no período.', <>from, to</>],
            [<C key="4">GET /reports/agents</C>, 'Resumo por operador no período.', <>from, to, team_id</>],
            [<C key="5">GET /reports/tabulations</C>, 'Distribuição das tabulações de encerramento.', <>from, to, team_id, agent_id</>],
          ]}
        />
        <ul className="max-w-[68ch] list-disc space-y-1 pl-5 text-sm text-foreground/90">
          <li>
            Datas: <C>from=2026-10-01&amp;to=2026-10-07</C> (inclusivas, calendário de Brasília), no máximo <strong>366 dias</strong> por chamada — para mais, consulte em blocos.
          </li>
          <li>
            <C>team_id</C> e <C>agent_id</C> são UUIDs. O <C>account_id</C> nunca é enviado: vem da chave.
          </li>
        </ul>
        <CodeTabs snippets={snippets.relatorio} title="Relatório de operação" />
      </Section>

      {/* 6 ─ Erros */}
      <Section
        id="erros"
        title="Erros e limites"
        intro={
          <>
            Falhas vêm como <C>{'{ "error": { "code": "…", "message": "…" } }'}</C>. Ramifique pelo <C>code</C> (estável); a <C>message</C> é para humanos e pode mudar.
          </>
        }
      >
        <Table
          head={['HTTP', 'error.code', 'O que significa', 'O que fazer']}
          rows={ERROR_ROWS.map((r) => [r.http, <C key="c">{r.code}</C>, r.significa, r.fazer])}
        />
        <Callout title="Limite de requisições: 120 por minuto, por chave">
          <p>
            Ao passar, a resposta é <C>429</C> com <C>Retry-After</C> (segundos). Os headers <C>X-RateLimit-Limit</C>, <C>X-RateLimit-Remaining</C> e <C>X-RateLimit-Reset</C> mostram quanto resta. Faça
            nova tentativa só depois do <C>Retry-After</C>.
          </p>
        </Callout>
        <P>
          Precisa de todos os campos e exemplos de resposta? Veja a aba <strong>Referência</strong>, no topo desta página.
        </P>
      </Section>
    </div>
  );
}

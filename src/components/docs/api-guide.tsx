// Guia da API (português, curto e direto): "Comece aqui", notas por grupo de rotas e "Erros e limites".
// Textos e regras são os do guia anterior; aqui só mudam organização e apresentação. Sem hooks: só
// CodeTabs/CodeBlock são client.

import type { ReactNode } from 'react';
import { ArrowRight, KeyRound, Link2, ShieldCheck, Zap } from 'lucide-react';

import { ERROR_ROWS, SCOPE_ROWS, type GuideExamples } from '@/lib/api/v1/docs-guide';
import { CodeBlock, CodeTabs } from './code-tabs';

export const C = ({ children }: { children: ReactNode }) => (
  <code className="rounded-md bg-surface-3 px-1.5 py-0.5 font-mono text-[0.85em] font-medium text-foreground">{children}</code>
);
const H3 = ({ children }: { children: ReactNode }) => <h3 className="pt-1 font-heading text-base font-semibold text-foreground">{children}</h3>;
const P = ({ children }: { children: ReactNode }) => <p className="max-w-[68ch] text-sm leading-relaxed text-foreground-2">{children}</p>;
const UL = ({ children }: { children: ReactNode }) => (
  <ul className="max-w-[68ch] list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-foreground-2">{children}</ul>
);

function Callout({ tone = 'info', title, children }: { tone?: 'info' | 'warn'; title: string; children: ReactNode }) {
  return (
    <div className={tone === 'warn' ? 'rounded-field border border-warning-border bg-warning-soft p-4' : 'rounded-field border border-border bg-info-soft p-4'}>
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <div className="mt-1 space-y-1 text-sm text-foreground-2">{children}</div>
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded-field border border-border">
      <table className="w-full min-w-[34rem] text-left text-sm">
        <thead className="bg-surface-3 text-xs text-muted-foreground">
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
                <td key={j} className="px-3 py-2.5 text-foreground-2">
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

/** Cartão de seção do guia (Comece aqui, Erros e limites). */
export function GuideSection({ id, title, intro, children }: { id: string; title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-titulo`} className="scroll-mt-24 space-y-5">
      <div className="space-y-2">
        <h2 id={`${id}-titulo`} className="font-heading text-[26px] font-semibold leading-tight tracking-[-0.025em] text-foreground">
          {title}
        </h2>
        {intro ? <p className="max-w-[68ch] text-sm leading-relaxed text-foreground-2">{intro}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-4 rounded-card border border-border bg-card p-5 shadow-sm">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary-soft font-heading text-sm font-semibold text-primary-text" aria-hidden="true">
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-3">
        <h3 className="font-heading text-base font-semibold text-foreground">{title}</h3>
        {children}
      </div>
    </li>
  );
}

const GOALS: Array<{ title: string; text: string; href: string }> = [
  { title: 'Disparar campanha', text: 'Mande milhares de contatos de uma vez, pelo canal Meta (template) ou WAHA (texto livre).', href: '#grupo-disparador' },
  { title: 'Acompanhar', text: 'Consulte status, enviadas, entregues, lidas e erros da campanha.', href: '#getCampaign' },
  { title: 'Envio avulso', text: 'Uma mensagem para um telefone (aviso, confirmação, boleto).', href: '#grupo-mensagens' },
  { title: 'Relatórios', text: 'Números agregados de atendimento para Power BI, Metabase ou n8n.', href: '#grupo-relatorios' },
  { title: 'Extrair conversas e mensagens', text: 'Histórico paginado para BI e auditoria.', href: '#grupo-extracao' },
  { title: 'Receber avisos (webhooks)', text: 'O CRM chama a sua URL quando algo acontece.', href: '#grupo-webhooks' },
];

export function IntroSection({ examples }: { examples: GuideExamples }) {
  return (
    <GuideSection
      id="comece"
      title="Comece aqui"
      intro="A API pública deixa o seu sistema (planejamento de cobrança, n8n, BI) falar com o CRM sem abrir o painel: disparar campanhas, mandar mensagens avulsas, acompanhar resultados e puxar relatórios."
    >
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {GOALS.map((g) => (
          <a
            key={g.title}
            href={g.href}
            className="group flex flex-col gap-1 rounded-card border border-border bg-card p-4 shadow-sm transition-all hover:-translate-y-px hover:bg-surface-hover hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <span className="flex items-center justify-between gap-2 font-heading text-sm font-semibold text-foreground">
              {g.title}
              <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
            </span>
            <span className="text-sm text-foreground-2">{g.text}</span>
          </a>
        ))}
      </div>

      <ol className="space-y-4">
        <Step n={1} title="URL base">
          <P>
            Todas as rotas começam por esta URL (a mesma do CRM, mais <C>/api/v1</C>):
          </P>
          <CodeBlock code={examples.baseUrl} label="URL base" />
        </Step>

        <Step n={2} title="Peça a sua chave">
          <ol className="max-w-[68ch] list-decimal space-y-1 pl-5 text-sm leading-relaxed text-foreground-2">
            <li>
              No CRM, abra <strong>Integrações → Chaves de API</strong>.
            </li>
            <li>
              Só quem é <strong>admin</strong> (ou dono da conta) cria chaves: peça a essa pessoa se o botão não aparecer.
            </li>
            <li>Marque só os escopos de que precisa (tabela abaixo) e crie.</li>
            <li>
              <strong>Copie a chave na hora:</strong> ela aparece uma única vez e começa com <C>wacrm_live_</C>. Guarde num cofre/variável de ambiente — nunca em código público.
            </li>
            <li>
              Envie a chave em todo pedido, no header <C>Authorization: Bearer SUA_CHAVE_DE_API</C>.
            </li>
          </ol>
          <Callout tone="warn" title="A chave é da conta">
            <p>Ela só age na conta em que foi criada. Se vazar, revogue em Integrações → Chaves de API e crie outra.</p>
          </Callout>
        </Step>

        <Step n={3} title="Escopos: o que cada chave pode fazer">
          <Table
            head={['Escopo', 'Serve para', 'Rotas']}
            rows={SCOPE_ROWS.map((r) => [<C key="s">{r.scope}</C>, r.paraQue, <C key="e">{r.endpoints}</C>])}
          />
          <P>
            Exemplo: para <strong>disparar campanha</strong> a chave precisa de <C>campaigns:write</C>.
          </P>
        </Step>

        <Step n={4} title="Primeiro teste: “quem sou eu?”">
          <P>
            Troque <C>SUA_CHAVE_DE_API</C> pela sua chave. Se voltar o nome da conta, está tudo certo.
          </P>
          <CodeTabs snippets={examples.snippets.me} title="Primeiro teste" />
          <P>
            Resposta de sucesso: <C>{'{ "data": { "account": …, "key": { "scopes": […] } } }'}</C>. Toda resposta vem em <C>data</C> (sucesso) ou em <C>error</C> (falha).
          </P>
        </Step>
      </ol>

      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { icon: KeyRound, title: 'Autenticação', text: 'Bearer com a chave da conta, no header Authorization.' },
          { icon: Zap, title: '120 por minuto', text: 'Limite por chave. Passou? 429 com Retry-After.' },
          { icon: ShieldCheck, title: 'Sem segredo na página', text: 'Os exemplos usam sempre o marcador SUA_CHAVE_DE_API.' },
        ].map((f) => (
          <div key={f.title} className="flex gap-3 rounded-card border border-border bg-card p-4">
            <f.icon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
            <div>
              <p className="text-sm font-semibold text-foreground">{f.title}</p>
              <p className="mt-0.5 text-sm text-foreground-2">{f.text}</p>
            </div>
          </div>
        ))}
      </div>
    </GuideSection>
  );
}

/** Notas que antecedem as rotas de cada grupo (regras que a descrição de uma rota sozinha não explica). */
export function GroupNotes({ group, examples }: { group: string; examples: GuideExamples }): ReactNode {
  switch (group) {
    case 'Disparador':
      return <CampaignNotes examples={examples} />;
    case 'Mensagens':
      return <SendNotes />;
    case 'Relatórios':
      return <ReportNotes />;
    case 'Extração':
      return <ExtractNotes />;
    case 'Webhooks':
      return <WebhookNotes />;
    default:
      return null;
  }
}

function CampaignNotes({ examples }: { examples: GuideExamples }) {
  return (
    <div className="space-y-5 rounded-card border border-border bg-surface-3/50 p-5">
      <div className="space-y-2">
        <H3>Meta × WAHA: uma rota, dois tipos de canal</H3>
        <P>
          Uma só rota — <C>POST /disparador/campaigns</C> — para os dois tipos de canal. A diferença está no que você manda para cada um. A campanha entra na fila na hora e o CRM envia
          dentro da janela de horário.
        </P>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="min-w-0 space-y-3 rounded-card border border-border bg-card p-4">
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-primary-solid px-2.5 py-0.5 text-xs font-semibold text-primary-foreground">Meta</span>
            <p className="text-sm font-semibold text-foreground">Canal oficial (WhatsApp Cloud API)</p>
          </div>
          <UL>
            <li>
              Envie <C>template_name</C>: o nome de um template <strong>já aprovado</strong> na WABA do canal.
            </li>
            <li>
              <C>variables</C> de cada contato vão como parâmetros do template — <strong>a Meta faz a substituição</strong> do <C>{'{{1}}'}</C>, <C>{'{{2}}'}</C>…
            </li>
            <li>
              <C>channel</C>: UUID do canal ou o número do canal Meta (ex.: <C>+55 21 3030-9159</C>).
            </li>
          </UL>
          <CodeBlock code={examples.payloadMeta} label="Corpo (JSON) — Meta" />
        </div>

        <div className="min-w-0 space-y-3 rounded-card border border-border bg-card p-4">
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-secondary px-2.5 py-0.5 text-xs font-semibold text-secondary-foreground">WAHA</span>
            <p className="text-sm font-semibold text-foreground">Canal WAHA (texto livre)</p>
          </div>
          <UL>
            <li>
              Envie <C>message</C>: texto livre com <C>{'{{1}}'}</C>, <C>{'{{2}}'}</C>… <strong>O CRM substitui</strong> pelos valores de <C>variables</C> de cada contato.
            </li>
            <li>
              Não existe template aprovado: não mande <C>template_name</C>.
            </li>
            <li>
              <C>channel</C>: só o <strong>UUID</strong> do canal (WAHA não aceita número).
            </li>
            <li>
              Se faltar valor para um <C>{'{{n}}'}</C>, o contato vai para <C>invalid</C> com motivo <C>missing_variable</C>.
            </li>
          </UL>
          <CodeBlock code={examples.payloadWaha} label="Corpo (JSON) — WAHA" />
        </div>
      </div>

      <Callout title="Não misture os dois">
        <p>
          Meta usa <C>template_name</C> + <C>variables</C> (a Meta substitui). WAHA usa <C>message</C> + <C>variables</C> (o CRM substitui). Mandar o campo do outro tipo gera erro 400.
        </p>
      </Callout>

      <H3>O que a resposta de criação traz</H3>
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
      <UL>
        <li>
          Até <strong>20.000 contatos por chamada</strong> (corpo de até 15 MB). Acima disso: <C>413</C> — divida em várias campanhas.
        </li>
        <li>
          O envio só acontece dentro da <strong>janela</strong> (<C>janela_inicio</C>–<C>janela_fim</C>, horário de Brasília; padrão 08:00–18:00) e nos <strong>dias permitidos</strong> (<C>dias_envio</C>; padrão
          segunda a sexta). Criou às 20h? Começa às 08h do próximo dia permitido, sem rajada.
        </li>
        <li>
          Números repetidos são unificados <strong>com e sem o 9º dígito</strong> e com ou sem +55.
        </li>
      </UL>

      <H3>Como evitar campanha duplicada</H3>
      <P>
        Se a sua chamada falhar por rede e você tentar de novo, pode criar duas campanhas. Evite mandando <C>external_id</C> no corpo (um id do seu sistema) <strong>ou</strong> o header <C>Idempotency-Key</C>{' '}
        (8–128 caracteres). Repetir com o mesmo conteúdo devolve a campanha que já existe (200); com outro conteúdo, <C>409</C>.
      </P>

      <H3>Acompanhar a campanha</H3>
      <P>
        Use o <C>campaign_id</C> da criação em <C>GET /disparador/campaigns/{'{id}'}</C> (escopo <C>campaigns:read</C> ou <C>campaigns:write</C>).
      </P>
      <Table
        head={['Campo', 'Significa']}
        rows={[
          [<C key="a">status</C>, <>Ex.: <C>em_execucao</C>, <C>pausada</C>, <C>encerrada</C>.</>],
          [<C key="b">metrics</C>, 'Total, enviadas, entregues, lidas, erros e pendentes.'],
          [<C key="c">queue</C>, 'Contagem por situação na fila: agendado, enviando, entregue, erro, cancelado.'],
          [<C key="d">window</C>, 'Janela de envio da campanha.'],
        ]}
      />
      <P>
        Consulte de tempos em tempos (por exemplo a cada minuto) — sem passar de 120 requisições por minuto. Campanha de outra conta devolve <C>404</C>.
      </P>
    </div>
  );
}

function SendNotes() {
  return (
    <div className="space-y-4 rounded-card border border-border bg-surface-3/50 p-5">
      <P>
        <C>POST /whatsapp/send</C> manda uma mensagem (texto e/ou mídia) para um telefone, pelo canal habilitado da conta. Escopo <C>messages:send</C>.
      </P>
      <UL>
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
      </UL>
      <Callout tone="warn" title="Janela de 24 horas da Meta">
        <p>
          Este endpoint manda texto livre, <strong>sem template</strong>. Em canal Meta, fora da janela de 24 h desde a última mensagem do cliente, a Meta recusa texto livre e você recebe erro do provedor
          (<C>502</C>). Para falar com quem não respondeu nas últimas 24 h, use uma <strong>campanha com template aprovado</strong>.
        </p>
      </Callout>
    </div>
  );
}

function ReportNotes() {
  return (
    <div className="space-y-3 rounded-card border border-border bg-surface-3/50 p-5">
      <P>
        Rotas <C>GET /reports/*</C> (escopo <C>reports:read</C>): só leitura e só números agregados — nunca mensagens, CPF ou credenciais. Ligue direto no Power BI, Metabase ou n8n.
      </P>
      <UL>
        <li>
          Datas: <C>from=2026-10-01&amp;to=2026-10-07</C> (inclusivas, calendário de Brasília), no máximo <strong>366 dias</strong> por chamada — para mais, consulte em blocos.
        </li>
        <li>
          <C>team_id</C> e <C>agent_id</C> são UUIDs. O <C>account_id</C> nunca é enviado: vem da chave.
        </li>
      </UL>
    </div>
  );
}

function ExtractNotes() {
  return (
    <div className="space-y-3 rounded-card border border-border bg-surface-3/50 p-5">
      <UL>
        <li>
          Ordem ascendente e paginação por <C>cursor</C> (repasse o <C>next_cursor</C>; <C>null</C> = fim): sem buracos nem repetição. <C>seq</C> é a posição da mensagem na conversa e não muda.
        </li>
        <li>
          <C>author.type</C>: customer, operator, ai, flow, campaign, automation ou api. A mídia vem <strong>sem URL</strong>; com <C>include_media_urls=true</C>, URL assinada de 15 minutos.
        </li>
        <li>
          Não saem chat interno, notas internas, dados da IA nem CPF. Limite de <strong>60 requisições por minuto</strong> por chave nestas rotas; cada extração é auditada (só a contagem, nunca o conteúdo).
        </li>
      </UL>
    </div>
  );
}

function WebhookNotes() {
  return (
    <div className="space-y-4 rounded-card border border-border bg-surface-3/50 p-5">
      <P>
        Em vez de consultar o CRM de tempos em tempos, cadastre uma URL <strong>https</strong> pública em <C>POST /webhooks</C> (escopo <C>webhooks:write</C>) e o CRM avisa quando algo acontece. O segredo{' '}
        <C>whsec_…</C> aparece <strong>uma única vez</strong>, na criação.
      </P>
      <Table
        head={['Evento', 'Quando acontece']}
        rows={[
          [<C key="1">message.received</C>, 'Chegou mensagem de cliente (texto, telefone, conversa e contato).'],
          [<C key="2">message.status</C>, 'Mensagem enviada mudou de status: sent, delivered, read ou failed.'],
          [<C key="3">conversation.closed</C>, 'Conversa encerrada, com a tabulação de encerramento quando houver.'],
          [<C key="4">agreement.created</C>, "Tabulação 'Acordo Realizado' aplicada à conversa."],
          [<C key="5">contact.opt_out</C>, 'Contato pediu para não receber mensagens.'],
        ]}
      />
      <H3>Como validar a assinatura</H3>
      <P>
        Cada chamada traz <C>X-CRM-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</C>, onde <C>v1</C> é o HMAC-SHA256 do texto <C>t + &quot;.&quot; + corpo</C> com o seu segredo. Calcule sobre o corpo{' '}
        <strong>bruto</strong>, compare em tempo constante e <strong>rejeite se |agora − t| passar de 5 minutos</strong>.
      </P>
      <UL>
        <li>
          Responda <strong>2xx em até 10 segundos</strong>. Redirecionamentos não são seguidos.
        </li>
        <li>
          Falhou? O CRM tenta de novo com intervalo crescente (30 s, 1 min, 2 min… até 1 h) por <strong>12 tentativas</strong>; depois a entrega fica <C>dead</C> em{' '}
          <C>GET /webhooks/{'{id}'}/deliveries?state=dead</C> e você reenvia com <C>POST …/replay</C>.
        </li>
        <li>
          Pelo menos uma vez, sem ordem garantida: <strong>deduplique pelo <C>id</C> do evento</strong>.
        </li>
        <li>
          Teste antes de valer: <C>POST /webhooks/{'{id}'}/test</C> envia um <C>webhook.test</C>. Trate o endpoint como dado sensível — <C>message.received</C> traz telefone e texto do cliente.
        </li>
      </UL>
    </div>
  );
}

export function ErrorsSection() {
  return (
    <GuideSection
      id="erros"
      title="Erros e limites"
      intro={
        <>
          Falhas vêm como <C>{'{ "error": { "code": "…", "message": "…" } }'}</C>. Ramifique pelo <C>code</C> (estável); a <C>message</C> é para humanos e pode mudar.
        </>
      }
    >
      <Table head={['HTTP', 'error.code', 'O que significa', 'O que fazer']} rows={ERROR_ROWS.map((r) => [r.http, <C key="c">{r.code}</C>, r.significa, r.fazer])} />
      <Callout title="Limite de requisições: 120 por minuto, por chave">
        <p>
          Ao passar, a resposta é <C>429</C> com <C>Retry-After</C> (segundos). Os headers <C>X-RateLimit-Limit</C>, <C>X-RateLimit-Remaining</C> e <C>X-RateLimit-Reset</C> mostram quanto resta. Faça nova
          tentativa só depois do <C>Retry-After</C>.
        </p>
      </Callout>
      <p className="flex items-center gap-1.5 text-sm text-foreground-2">
        <Link2 className="size-4 text-muted-foreground" aria-hidden="true" />
        Cada rota, com todos os campos e exemplos de resposta, está nos grupos acima.
      </p>
    </GuideSection>
  );
}

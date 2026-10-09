"use client";

import { useState } from "react";
import { 
  Smartphone, 
  Bot, 
  Megaphone, 
  GitBranch, 
  HelpCircle
} from "lucide-react";
import { PageBody } from "@/components/ddm/page-toolbar";

export default function HelpPage() {
  const [activeTab, setActiveTab] = useState<"whatsapp" | "ai" | "campaigns" | "pipeline" | "faq">("whatsapp");

  const tabs = [
    { id: "whatsapp", label: "Conexão WhatsApp", icon: Smartphone },
    { id: "ai", label: "Agente de IA (Robô)", icon: Bot },
    { id: "campaigns", label: "Campanhas e Ligações", icon: Megaphone },
    { id: "pipeline", label: "Funis de Vendas (CRM)", icon: GitBranch },
    { id: "faq", label: "Perguntas Frequentes", icon: HelpCircle },
  ] as const;

  return (
    <PageBody className="gap-4">
      <div className="flex animate-ddm-up flex-col gap-1.5 pt-1">
        <h1 className="font-heading text-[28px] font-semibold leading-tight tracking-[-0.025em] text-foreground">Ajuda</h1>
        <p className="max-w-[620px] text-sm leading-relaxed text-muted-foreground">
          Guia do usuário e primeiros passos.
        </p>
      </div>

      {/* Seletor de tópicos (trilho segmentado do design system DDM) */}
      <div
        role="group"
        aria-label="Tópicos da ajuda"
        className="flex max-w-full gap-0.5 self-start overflow-x-auto rounded-lg bg-surface-3 p-[3px] [scrollbar-width:none]"
      >
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              aria-pressed={isActive}
              onClick={() => setActiveTab(tab.id)}
              className={`flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[6px] px-2.5 text-[12.5px] font-semibold transition-colors ${
                isActive
                  ? "bg-card text-foreground shadow-[0_1px_2px_rgba(0,0,0,.12),0_0_0_1px_var(--border)]"
                  : "text-foreground-2 hover:text-foreground"
              }`}
            >
              <Icon className="size-3.5 shrink-0" aria-hidden />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Main Tab Content */}
      <div className="min-h-[400px] rounded-[10px] border border-border bg-card p-6">
        
        {/* TAB 1: WHATSAPP */}
        {activeTab === "whatsapp" && (
          <div className="space-y-6 animate-ddm-fade">
            <div className="space-y-1">
              <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
                <Smartphone className="h-5 w-5 text-primary" /> Conectando o seu WhatsApp no CRM
              </h2>
              <p className="text-xs text-muted-foreground">
                Siga as etapas abaixo para vincular o seu aparelho celular ao painel.
              </p>
            </div>

            <div className="grid md:grid-cols-3 gap-4">
              <div className="bg-muted/40 border border-border rounded-xl p-4 space-y-2">
                <div className="h-7 w-7 rounded-lg bg-primary/10 text-primary font-bold flex items-center justify-center text-xs">1</div>
                <h4 className="text-xs font-bold text-foreground">Acesse as Conexões</h4>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  No menu lateral, vá em **Configurações** e clique na aba **WhatsApp** (ou na área de conexões do cabeçalho).
                </p>
              </div>

              <div className="bg-muted/40 border border-border rounded-xl p-4 space-y-2">
                <div className="h-7 w-7 rounded-lg bg-primary/10 text-primary font-bold flex items-center justify-center text-xs">2</div>
                <h4 className="text-xs font-bold text-foreground">Gere o QR Code</h4>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Se a instância estiver desconectada, clique para gerar o QR Code. Ele aparecerá na tela em instantes.
                </p>
              </div>

              <div className="bg-muted/40 border border-border rounded-xl p-4 space-y-2">
                <div className="h-7 w-7 rounded-lg bg-primary/10 text-primary font-bold flex items-center justify-center text-xs">3</div>
                <h4 className="text-xs font-bold text-foreground">Escaneie com o Celular</h4>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  No celular, abra o WhatsApp, vá em **Aparelhos Conectados** &gt; **Conectar Aparelho** e aponte para o QR Code da tela.
                </p>
              </div>
            </div>

            <div className="bg-primary/5 border border-primary/20 rounded-xl p-4 flex gap-3 items-start">
              <span className="text-lg">💡</span>
              <div className="space-y-1">
                <h5 className="text-xs font-bold text-primary">Importante:</h5>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Mantenha a bateria do seu celular carregada e o aparelho conectado à internet. O robô utiliza a conexão do celular para enviar as mensagens e fazer as chamadas.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: AI AGENT */}
        {activeTab === "ai" && (
          <div className="space-y-6 animate-ddm-fade">
            <div className="space-y-1">
              <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
                <Bot className="h-5 w-5 text-primary" /> Configurando o Agente de IA (Auto-responder)
              </h2>
              <p className="text-xs text-muted-foreground">
                Treine a Inteligência Artificial para atender seus clientes 24/7 de forma personalizada.
              </p>
            </div>

            <div className="space-y-4">
              <div className="flex gap-4 items-start border-b border-border pb-4">
                <div className="h-8 w-8 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">🤖</div>
                <div className="space-y-1 flex-1">
                  <h4 className="text-xs font-bold text-foreground">1. Instruções de Comportamento (System Prompt)</h4>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Aqui você define quem o robô é, qual a sua personalidade (ex: comercial, amigável, técnico) e como ele deve saudar os clientes. Dica: ordene que ele responda de forma curta e objetiva.
                  </p>
                </div>
              </div>

              <div className="flex gap-4 items-start border-b border-border pb-4">
                <div className="h-8 w-8 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">📂</div>
                <div className="space-y-1 flex-1">
                  <h4 className="text-xs font-bold text-foreground">2. Base de Conhecimento (RAG)</h4>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    A IA não sabe os preços ou detalhes dos seus produtos/serviços até você ensiná-la. Crie um arquivo no Bloco de Notas (`.txt`) ou `.pdf` listando tudo sobre sua empresa (FAQ, preços, links) e faça o upload. A IA consultará esse arquivo antes de cada resposta.
                  </p>
                </div>
              </div>

              <div className="flex gap-4 items-start">
                <div className="h-8 w-8 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">🎙️</div>
                <div className="space-y-1 flex-1">
                  <h4 className="text-xs font-bold text-foreground">3. Transcrição de Áudio (Whisper)</h4>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Ative o recurso **&quot;Interpretar Mídia (Áudio e Imagem)&quot;**. Isso permite que o robô de IA ouça e transcreva as mensagens de áudio que os clientes te mandam, gerando respostas em texto normais.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: CAMPAIGNS */}
        {activeTab === "campaigns" && (
          <div className="space-y-6 animate-ddm-fade">
            <div className="space-y-1">
              <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
                <Megaphone className="h-5 w-5 text-primary" /> Disparador de Campanhas e Ligações Automatizadas
              </h2>
              <p className="text-xs text-muted-foreground">
                Como enviar mensagens em massa de texto, imagens, áudios ou realizar chamadas de voz reais.
              </p>
            </div>

            <div className="space-y-4">
              <div className="bg-muted/30 border border-border rounded-xl p-4 space-y-3">
                <h4 className="text-xs font-bold text-foreground flex items-center gap-1.5">
                  <span className="p-1 rounded bg-orange-500/10 text-orange-500">📞</span> Como configurar Ligações Automáticas:
                </h4>
                <ol className="list-decimal list-inside text-[11px] leading-relaxed text-muted-foreground space-y-1.5 pl-2">
                  <li>No menu **Disparador**, clique em **Nova Campanha**.</li>
                  <li>No criador de etapas, escolha o tipo **Ligação**.</li>
                  <li>Faça o upload do seu áudio pré-gravado (WAV ou MP3). Recomendamos áudios mono e curtos para simular uma ligação real.</li>
                  <li>Configure os filtros e ative a campanha.</li>
                  <li>O CRM ligará para o celular do cliente. Assim que ele **atender**, o áudio que você subiu começará a tocar automaticamente.</li>
                </ol>
              </div>

              <div className="bg-muted/30 border border-border rounded-xl p-4 space-y-3">
                <h4 className="text-xs font-bold text-foreground flex items-center gap-1.5">
                  <span className="p-1 rounded bg-orange-500/10 text-orange-500">🎙️</span> Diferença entre Áudio Chat e Ligação:
                </h4>
                <div className="grid md:grid-cols-2 gap-4 text-[11px] leading-relaxed text-muted-foreground">
                  <div className="space-y-1">
                    <strong className="text-foreground font-semibold">Áudio Chat (Mensagem de Voz):</strong>
                    <p>O cliente recebe o áudio no chat do WhatsApp com o ícone de microfone azul. O celular **não toca**.</p>
                  </div>
                  <div className="space-y-1">
                    <strong className="text-foreground font-semibold">Ligação (Chamada):</strong>
                    <p>O celular do cliente **toca e vibra** com uma chamada recebida no WhatsApp. O áudio toca ao ser atendida.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 4: PIPELINES */}
        {activeTab === "pipeline" && (
          <div className="space-y-6 animate-ddm-fade">
            <div className="space-y-1">
              <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
                <GitBranch className="h-5 w-5 text-primary" /> Kanban e Funis de Venda (CRM)
              </h2>
              <p className="text-xs text-muted-foreground">
                Entenda o fluxo comercial e a automatização de negócios integrados.
              </p>
            </div>

            <div className="space-y-4">
              <div className="grid md:grid-cols-2 gap-4">
                <div className="bg-muted/40 border border-border rounded-xl p-4 space-y-2">
                  <h4 className="text-xs font-bold text-foreground">Geração Automática de Negócios</h4>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Sempre que um novo número de WhatsApp entra em contato com sua empresa, o CRM cria **automaticamente** um card de negócio na primeira coluna do seu Funil de Vendas (Kanban), com o valor inicial de R$ 0.
                  </p>
                </div>

                <div className="bg-muted/40 border border-border rounded-xl p-4 space-y-2">
                  <h4 className="text-xs font-bold text-foreground">Sincronização de Nomes Inteligente</h4>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Ao criar o negócio, o título pode ser o número de telefone temporariamente. No instante em que o WhatsApp do cliente nos envia o nome real do perfil dele, o CRM **atualiza automaticamente** o card do Kanban com o nome correto.
                  </p>
                </div>
              </div>

              <div className="bg-muted/40 border border-border rounded-xl p-4 space-y-2">
                <h4 className="text-xs font-bold text-foreground">Edição Rápida</h4>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Se quiser alterar manualmente o nome de um cliente, abra a conversa dele no menu **Conversas**, clique sobre o nome na barra lateral direita, digite o novo nome e clique em **Salvar**. Isso alterará o nome dele em todo o sistema (chat, contatos e Kanban).
                </p>
              </div>
            </div>
          </div>
        )}

        {/* TAB 5: FAQ */}
        {activeTab === "faq" && (
          <div className="space-y-6 animate-ddm-fade">
            <div className="space-y-1">
              <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
                <HelpCircle className="h-5 w-5 text-primary" /> Perguntas Frequentes & Solução de Problemas
              </h2>
              <p className="text-xs text-muted-foreground">
                Respostas rápidas para as dúvidas mais comuns.
              </p>
            </div>

            <div className="space-y-3.5">
              <div className="border border-border rounded-xl p-4 bg-muted/20 space-y-1.5">
                <h4 className="text-xs font-bold text-foreground">❓ A Inteligência Artificial parou de responder, o que fazer?</h4>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Verifique se o interruptor **&quot;Ativo&quot;** na página do Agente de IA está ligado. Também confirme se o seu WhatsApp está conectado com o ícone verde de sucesso no menu superior. Se a conexão cair, a IA não consegue responder.
                </p>
              </div>

              <div className="border border-border rounded-xl p-4 bg-muted/20 space-y-1.5">
                <h4 className="text-xs font-bold text-foreground">❓ O robô de IA atende todos os contatos que entram no WhatsApp?</h4>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Sim. Quando ativo, ele assume o atendimento. Caso um atendente humano envie uma mensagem manual no chat pelo CRM, o robô é pausado automaticamente para aquele cliente para evitar conflito com o vendedor humano.
                </p>
              </div>

              <div className="border border-border rounded-xl p-4 bg-muted/20 space-y-1.5">
                <h4 className="text-xs font-bold text-foreground">❓ Posso usar mais de uma Base de Conhecimento na IA?</h4>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Sim! Você pode carregar múltiplos arquivos TXT ou PDF na seção **Base de Conhecimento** do Agente. O robô irá ler e combinar os dados de todos eles para responder aos clientes.
                </p>
              </div>
            </div>
          </div>
        )}

      </div>
    </PageBody>
  );
}

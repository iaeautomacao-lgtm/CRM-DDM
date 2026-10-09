"use client";

/**
 * Per-node configuration form, dispatched by node_type.
 *
 * One component, ten branches. Each branch renders the inputs that
 * map onto the node's `config` JSONB shape (text + buttons for
 * send_buttons, prompt + var_key for collect_input, etc.) and forwards
 * edits up via `onUpdateConfig`.
 *
 * Why this lives in src/components/flows/forms/ instead of next to
 * the list editor: PR 2 (canvas editing) needs to mount the same
 * form in a side panel when a user clicks a node on the canvas.
 * Keeping the per-node forms here means there's exactly one place
 * where each form's behaviour and validation lives — drift between
 * "what the list editor shows" and "what the canvas side panel
 * shows" becomes impossible.
 *
 * `showAdvanced` is the disclosure that surfaces internal
 * identifiers (node_key, button reply_id, list row reply_id) — owned
 * by the host (NodeCard / SideSheet) so the toggle is rendered
 * outside this form alongside whatever delete/cancel buttons that
 * host wants. The form just reads the boolean and conditionally
 * renders the advanced rows.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Loader2,
  Paperclip,
  Plus,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { uploadAccountMedia, MEDIA_MAX_BYTES } from "@/lib/storage/upload-media";
import { createClient } from "@/lib/supabase/client";
import { apiFetch } from "@/lib/api-fetch";
import { useAuth } from "@/hooks/use-auth";
import { slugify, type BuilderNode } from "../shared";
import { NextNodeRow, NodeKeySelect, TextRow } from "./fields";
import { useFlowEditor } from "../flow-editor-state";
import { AiToolEditor } from "./ai-tool-editor";
import { AgentPicker } from "./agent-picker";
import { PICKER_CHOSEN_VAR, PICKER_MAX_OPTIONS, PICKER_NO_AGENT_REPLY_ID } from "@/lib/flows/agent-picker";
import { ToolCatalogPicker } from "./tool-catalog-picker";
import { PromptHistoryButton } from "@/components/ai/prompt-history-button";
import {
  WEBCHAT_BUTTON_TEXT_MAX,
  type AiAgentTool,
  type AiAgentToolParameter,
} from "@/lib/flows/types";
import {
  aiProviderLabel,
  getAiModelsForProvider,
  type AiProvider,
} from "@/lib/ai/models";

interface NodeConfigFormProps {
  node: BuilderNode;
  allNodes: BuilderNode[];
  showAdvanced: boolean;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
}

function NodeConfigFields({
  node,
  allNodes,
  showAdvanced,
  onUpdateConfig,
}: NodeConfigFormProps) {
  const cfg = node.config;
  switch (node.node_type) {
    case "start":
      return (
        <NextNodeRow
          value={(cfg as { next_node_key?: string }).next_node_key ?? ""}
          allNodes={allNodes}
          currentKey={node.node_key}
          onChange={(v) => onUpdateConfig({ next_node_key: v })}
          label="Avança para"
        />
      );

    case "send_message":
      return (
        <>
          <TextRow
            label="Texto enviado ao cliente"
            value={(cfg as { text?: string }).text ?? ""}
            onChange={(v) => onUpdateConfig({ text: v })}
            rows={4}
          />
          <NextNodeRow
            value={(cfg as { next_node_key?: string }).next_node_key ?? ""}
            allNodes={allNodes}
            currentKey={node.node_key}
            onChange={(v) => onUpdateConfig({ next_node_key: v })}
            label="Avança para"
          />
        </>
      );

    case "send_buttons":
      return (
        <SendButtonsForm
          cfg={cfg as SendButtonsCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
          showAdvanced={showAdvanced}
        />
      );

    case "send_list":
      return (
        <SendListForm
          cfg={cfg as SendListCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
          showAdvanced={showAdvanced}
        />
      );

    case "send_media":
      return (
        <SendMediaForm
          cfg={cfg as SendMediaCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
        />
      );

    case "collect_input":
      return (
        <>
          <TextRow
            label="Pergunta enviada ao cliente"
            value={(cfg as { prompt_text?: string }).prompt_text ?? ""}
            onChange={(v) => onUpdateConfig({ prompt_text: v })}
            rows={2}
          />
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              Nome da variável (letras, números e _ — use depois como {"{{vars.nome}}"})
            </label>
            <Input
              value={(cfg as { var_key?: string }).var_key ?? ""}
              onChange={(e) =>
                onUpdateConfig({
                  var_key: e.target.value.replace(/[^a-zA-Z0-9_]/g, ""),
                })
              }
              placeholder="ex.: nome, email, empresa"
              className="bg-muted font-mono text-xs"
            />
            <p className="mt-1 text-[10px] text-muted-foreground">
              Use em perguntas seguintes e notas de transferência com{" "}
              <code className="rounded bg-muted px-1">
                {"{{vars."}
                {(cfg as { var_key?: string }).var_key || "nome"}
                {"}}"}
              </code>
              .
            </p>
          </div>
          <NextNodeRow
            value={(cfg as { next_node_key?: string }).next_node_key ?? ""}
            allNodes={allNodes}
            currentKey={node.node_key}
            onChange={(v) => onUpdateConfig({ next_node_key: v })}
            label="Depois de capturar, avança para"
          />
        </>
      );

    case "condition":
      return (
        <ConditionForm
          cfg={cfg as ConditionCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
        />
      );

    case "switch":
      return (
        <SwitchForm
          cfg={cfg as SwitchCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
        />
      );

    case "set_tag":
      return (
        <SetTagForm
          cfg={cfg as SetTagCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
        />
      );

    case "handoff":
      return (
        <HandoffForm cfg={cfg as HandoffCfg} onUpdateConfig={onUpdateConfig} />
      );

    case "handoff_agent":
      return (
        <HandoffAgentForm
          cfg={cfg as HandoffAgentCfg}
          onUpdateConfig={onUpdateConfig}
        />
      );

    case "handoff_team":
      return (
        <HandoffTeamForm
          cfg={cfg as HandoffTeamCfg}
          onUpdateConfig={onUpdateConfig}
        />
      );

    case "end":
      return (
        <p className="text-xs text-muted-foreground">
          Nó terminal. Quando o motor chega a este nó, a execução é marcada
          como concluída. Não precisa de configuração.
        </p>
      );

    case "http_fetch":
      return (
        <HttpFetchForm
          cfg={cfg as HttpFetchCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
        />
      );

    case "set_variable":
      return (
        <SetVariableForm
          cfg={cfg as SetVariableCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
        />
      );

    case "smart_delay":
      return (
        <SmartDelayForm
          cfg={cfg as SmartDelayCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
        />
      );

    case "anchor":
      return (
        <>
          <TextRow
            label="Nome da âncora"
            value={(cfg as { label?: string }).label ?? ""}
            onChange={(v) => onUpdateConfig({ label: v })}
          />
          <NextNodeRow
            value={(cfg as { next_node_key?: string }).next_node_key ?? ""}
            allNodes={allNodes}
            currentKey={node.node_key}
            onChange={(v) => onUpdateConfig({ next_node_key: v })}
            label="Avança para"
          />
        </>
      );

    case "go_to": {
      const anchors = allNodes.filter((n) => n.node_type === "anchor");
      return (
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            Ir para âncora
          </label>
          <NodeKeySelect
            value={(cfg as { target_node_key?: string }).target_node_key || null}
            nodes={anchors}
            excludeKey={node.node_key}
            onChange={(v) => onUpdateConfig({ target_node_key: v ?? "" })}
            placeholder="Escolha uma âncora…"
          />
          {anchors.length === 0 && (
            <p className="mt-1 text-[10px] text-muted-foreground">
              Nenhuma âncora neste fluxo ainda — adicione um nó &quot;Âncora&quot; primeiro.
            </p>
          )}
        </div>
      );
    }

    case "go_to_flow":
      return (
        <GoToFlowForm
          cfg={cfg as GoToFlowCfg}
          onUpdateConfig={onUpdateConfig}
        />
      );

    case "send_template":
      return (
        <SendTemplateForm
          cfg={cfg as SendTemplateCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
        />
      );

    case "send_flow":
      return (
        <SendFlowForm
          cfg={cfg as SendFlowCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
        />
      );

    case "add_note":
      return (
        <>
          <TextRow
            label="Texto da nota (interna — o cliente não vê)"
            value={(cfg as { note_text?: string }).note_text ?? ""}
            onChange={(v) => onUpdateConfig({ note_text: v })}
            rows={3}
          />
          <NextNodeRow
            value={(cfg as { next_node_key?: string }).next_node_key ?? ""}
            allNodes={allNodes}
            currentKey={node.node_key}
            onChange={(v) => onUpdateConfig({ next_node_key: v })}
            label="Avança para"
          />
        </>
      );

    case "receive_attachment":
      return (
        <ReceiveAttachmentForm
          cfg={cfg as ReceiveAttachmentCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
        />
      );

    case "ai_agent":
      return (
        <AiAgentForm
          cfg={cfg as AiAgentCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
        />
      );

    case "send_webchat":
      return (
        <SendWebchatForm
          cfg={cfg as { message_text?: string; button_text?: string; next_node_key?: string }}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
        />
      );
  }
}

// ============================================================
// send_webchat
// ============================================================

function SendWebchatForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
}: {
  cfg: { message_text?: string; button_text?: string; next_node_key?: string };
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
}) {
  const buttonText = cfg.button_text ?? "";
  return (
    <>
      <TextRow
        label="Mensagem do convite (enviada no WhatsApp)"
        value={cfg.message_text ?? ""}
        onChange={(v) => onUpdateConfig({ message_text: v })}
        rows={3}
      />
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">
          Texto do botão ({buttonText.length}/{WEBCHAT_BUTTON_TEXT_MAX})
        </label>
        <Input
          value={buttonText}
          maxLength={WEBCHAT_BUTTON_TEXT_MAX}
          onChange={(e) => onUpdateConfig({ button_text: e.target.value })}
          placeholder="Abrir chat"
          className="bg-muted text-xs"
        />
        <p className="mt-1 text-[10px] text-muted-foreground">
          Na Meta vira um botão; no WAHA o link vai no fim do texto. O link vale
          24h e é único para o contato.
        </p>
      </div>
      <NextNodeRow
        value={cfg.next_node_key ?? ""}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label="Quando o cliente abrir o Webchat, continua em"
      />
      <p className="text-[10px] text-muted-foreground">
        O fluxo no WhatsApp termina aqui. Ao abrir o link, este mesmo fluxo
        continua no Webchat a partir do nó escolhido, com as mesmas variáveis.
      </p>
    </>
  );
}

// ============================================================
// send_buttons
// ============================================================

interface SendButtonsCfg {
  text?: string;
  footer_text?: string;
  buttons?: Array<{ reply_id: string; title: string; next_node_key: string }>;
}

function SendButtonsForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
  showAdvanced,
}: {
  cfg: SendButtonsCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
  showAdvanced: boolean;
}) {
  const buttons = cfg.buttons ?? [];
  const updateButton = (
    idx: number,
    patch: Partial<NonNullable<SendButtonsCfg["buttons"]>[number]>,
  ) => {
    onUpdateConfig({
      buttons: buttons.map((b, i) => (i === idx ? { ...b, ...patch } : b)),
    });
  };
  const addButton = () =>
    onUpdateConfig({
      buttons: [
        ...buttons,
        {
          reply_id: nextFreeReplyId("btn", buttons.map((b) => b.reply_id)),
          title: "Opção",
          next_node_key: "",
        },
      ],
    });
  const removeButton = (idx: number) =>
    onUpdateConfig({ buttons: buttons.filter((_, i) => i !== idx) });

  return (
    <>
      <TextRow
        label="Texto da mensagem"
        value={cfg.text ?? ""}
        onChange={(v) => onUpdateConfig({ text: v })}
        rows={3}
      />
      <TextRow
        label="Rodapé (opcional, 60 caracteres)"
        value={cfg.footer_text ?? ""}
        onChange={(v) => onUpdateConfig({ footer_text: v })}
      />
      <div>
        <div className="mb-2 flex items-center justify-between">
          <label className="text-xs text-muted-foreground">
            Botões (1–3) — cada um leva a um nó diferente
          </label>
        </div>
        <div className="flex flex-col gap-3">
          {buttons.map((b, i) => (
            <div
              key={i}
              className={cn(
                "grid grid-cols-1 gap-2 rounded-md border border-border bg-muted/40 p-3",
                showAdvanced
                  ? "md:grid-cols-[1fr_2fr_2fr_auto]"
                  : "md:grid-cols-[2fr_2fr_auto]",
              )}
            >
              {showAdvanced && (
                <Input
                  value={b.reply_id}
                  onChange={(e) =>
                    updateButton(i, {
                      reply_id: slugify(e.target.value, `btn_${i + 1}`),
                    })
                  }
                  placeholder="id da resposta"
                  className="bg-muted font-mono text-xs"
                />
              )}
              <Input
                value={b.title}
                onChange={(e) => updateButton(i, { title: e.target.value })}
                placeholder="Título visível (≤20 caracteres)"
                className="bg-muted"
                maxLength={20}
              />
              <NodeKeySelect
                value={b.next_node_key || null}
                nodes={allNodes}
                excludeKey={currentKey}
                onChange={(v) => updateButton(i, { next_node_key: v ?? "" })}
                placeholder="Próximo nó…"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeButton(i)}
                className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
        {buttons.length < 3 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={addButton}
            className="mt-2"
          >
            <Plus className="h-3.5 w-3.5" />
            Adicionar botão
          </Button>
        )}
      </div>
    </>
  );
}

// ============================================================
// send_list
// ============================================================

interface SendListCfg {
  text?: string;
  button_label?: string;
  footer_text?: string;
  /** Menu de operadores online (PRD 23, item 16). */
  agent_picker?: { team_id?: string; max_options?: number } | null;
  sections?: Array<{
    title?: string;
    rows: Array<{
      reply_id: string;
      title: string;
      description?: string;
      next_node_key: string;
    }>;
  }>;
}

function SendListForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
  showAdvanced,
}: {
  cfg: SendListCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
  showAdvanced: boolean;
}) {
  const sections = cfg.sections ?? [];
  const totalRows = sections.reduce((sum, s) => sum + s.rows.length, 0);

  const updateSection = (
    sIdx: number,
    patch: Partial<NonNullable<SendListCfg["sections"]>[number]>,
  ) => {
    onUpdateConfig({
      sections: sections.map((s, i) =>
        i === sIdx ? { ...s, ...patch } : s,
      ),
    });
  };
  const addSection = () =>
    onUpdateConfig({
      sections: [
        ...sections,
        {
          title: "",
          rows: [
            {
              reply_id: nextFreeReplyId("row", sections.flatMap((s) => s.rows.map((r) => r.reply_id))),
              title: `Opção ${totalRows + 1}`,
              next_node_key: "",
            },
          ],
        },
      ],
    });
  const removeSection = (sIdx: number) =>
    onUpdateConfig({ sections: sections.filter((_, i) => i !== sIdx) });
  const updateRow = (
    sIdx: number,
    rIdx: number,
    patch: Partial<
      NonNullable<SendListCfg["sections"]>[number]["rows"][number]
    >,
  ) => {
    onUpdateConfig({
      sections: sections.map((s, i) =>
        i === sIdx
          ? {
              ...s,
              rows: s.rows.map((r, j) => (j === rIdx ? { ...r, ...patch } : r)),
            }
          : s,
      ),
    });
  };
  const addRow = (sIdx: number) =>
    onUpdateConfig({
      sections: sections.map((s, i) =>
        i === sIdx
          ? {
              ...s,
              rows: [
                ...s.rows,
                {
                  reply_id: nextFreeReplyId("row", sections.flatMap((s) => s.rows.map((r) => r.reply_id))),
                  title: `Opção ${totalRows + 1}`,
                  next_node_key: "",
                },
              ],
            }
          : s,
      ),
    });
  const removeRow = (sIdx: number, rIdx: number) =>
    onUpdateConfig({
      sections: sections.map((s, i) =>
        i === sIdx ? { ...s, rows: s.rows.filter((_, j) => j !== rIdx) } : s,
      ),
    });

  return (
    <>
      <TextRow
        label="Texto da mensagem"
        value={cfg.text ?? ""}
        onChange={(v) => onUpdateConfig({ text: v })}
        rows={3}
      />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <TextRow
          label="Rótulo do botão para expandir (≤20 caracteres)"
          value={cfg.button_label ?? ""}
          onChange={(v) => onUpdateConfig({ button_label: v })}
        />
        <TextRow
          label="Rodapé (opcional, 60 caracteres)"
          value={cfg.footer_text ?? ""}
          onChange={(v) => onUpdateConfig({ footer_text: v })}
        />
      </div>

      {/* Menu de operadores online (PRD 23, item 16): o cliente escolhe numa
          lista do WhatsApp entre os operadores ONLINE da equipe; ninguém online
          ⇒ destino de "ninguém online" (fila). As linhas são geradas na hora. */}
      <AgentPickerToggle cfg={cfg} onUpdateConfig={onUpdateConfig} />

      {cfg.agent_picker ? (
        <AgentPickerEditor cfg={cfg} allNodes={allNodes} currentKey={currentKey} onUpdateConfig={onUpdateConfig} />
      ) : (
      <div className="mt-2">
        <label className="mb-2 block text-xs text-muted-foreground">
          Linhas (1–10 no total, em todas as seções)
        </label>
        {sections.map((section, sIdx) => (
          <div
            key={sIdx}
            className="mb-3 rounded-md border border-border bg-muted/40 p-3"
          >
            <div className="mb-2 flex items-center gap-2">
              <Input
                value={section.title ?? ""}
                onChange={(e) =>
                  updateSection(sIdx, { title: e.target.value })
                }
                placeholder={`Título da seção ${sIdx + 1} (opcional)`}
                className="bg-muted text-xs"
              />
              {sections.length > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeSection(sIdx)}
                  className="shrink-0 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                  aria-label="Remover seção"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
            {section.rows.map((row, rIdx) => (
              <div
                key={rIdx}
                className={cn(
                  "mb-2 grid grid-cols-1 gap-2",
                  showAdvanced
                    ? "md:grid-cols-[1fr_2fr_2fr_auto]"
                    : "md:grid-cols-[2fr_2fr_auto]",
                )}
              >
                {showAdvanced && (
                  <Input
                    value={row.reply_id}
                    onChange={(e) =>
                      updateRow(sIdx, rIdx, {
                        reply_id: slugify(
                          e.target.value,
                          `row_${rIdx + 1}`,
                        ),
                      })
                    }
                    placeholder="id da resposta"
                    className="bg-muted font-mono text-xs"
                  />
                )}
                <Input
                  value={row.title}
                  onChange={(e) =>
                    updateRow(sIdx, rIdx, { title: e.target.value })
                  }
                  placeholder="Título da linha (≤24)"
                  className="bg-muted"
                  maxLength={24}
                />
                <NodeKeySelect
                  value={row.next_node_key || null}
                  nodes={allNodes}
                  excludeKey={currentKey}
                  onChange={(v) =>
                    updateRow(sIdx, rIdx, { next_node_key: v ?? "" })
                  }
                  placeholder="Próximo nó…"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeRow(sIdx, rIdx)}
                  className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            {totalRows < 10 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => addRow(sIdx)}
                className="mt-1"
              >
                <Plus className="h-3.5 w-3.5" />
                Adicionar linha
              </Button>
            )}
          </div>
        ))}
        {/* WhatsApp's interactive-list spec caps sections at 10. Group rows
            by category (Billing / Support / Sales etc.) to give customers a
            scannable menu. */}
        {sections.length < 10 && (
          <Button variant="outline" size="sm" onClick={addSection}>
            <Plus className="h-3.5 w-3.5" />
            Adicionar seção
          </Button>
        )}
      </div>
      )}
    </>
  );
}

// ============================================================
// send_list › menu de operadores online (PRD 23, item 16)
// Contrato em src/lib/flows/agent-picker.ts: config.agent_picker liga o modo;
// as linhas viram só TOPOLOGIA — a 1ª (modelo) aponta para onde vai quem
// escolheu um operador (um handoff_agent com assign_from_var
// "chosen_agent_id"); a "__no_agent" aponta para onde vai quando ninguém
// está online. O menu real é gerado na hora, um item por operador online.
// ============================================================

const PICKER_TEMPLATE_REPLY_ID = "agent_choice";

function AgentPickerToggle({
  cfg,
  onUpdateConfig,
}: {
  cfg: SendListCfg;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
}) {
  const on = Boolean(cfg.agent_picker);
  const toggle = (next: boolean) => {
    const rows = (cfg.sections ?? []).flatMap((s) => s.rows);
    if (next) {
      const firstNext = rows.find((r) => r.reply_id !== PICKER_NO_AGENT_REPLY_ID)?.next_node_key ?? "";
      onUpdateConfig({
        agent_picker: { max_options: PICKER_MAX_OPTIONS },
        sections: [
          {
            title: "",
            rows: [
              { reply_id: PICKER_TEMPLATE_REPLY_ID, title: "Operador", next_node_key: firstNext },
              { reply_id: PICKER_NO_AGENT_REPLY_ID, title: "Ninguém online", next_node_key: "" },
            ],
          },
        ],
      });
    } else {
      // Volta às linhas comuns: a linha modelo vira uma opção editável e a
      // "__no_agent" (que nunca aparece no menu) sai.
      onUpdateConfig({
        agent_picker: null,
        sections: (cfg.sections ?? []).map((s) => ({
          ...s,
          rows: s.rows.filter((r) => r.reply_id !== PICKER_NO_AGENT_REPLY_ID),
        })),
      });
    }
  };
  return (
    <label className="mt-2 flex items-start gap-3 rounded-md border border-border bg-card-2 p-3">
      <Switch checked={on} onCheckedChange={toggle} className="mt-0.5" />
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-foreground">Menu de operadores online</span>
        <span className="block text-xs text-muted-foreground">
          O cliente escolhe na lista com quem quer falar, entre os operadores online da equipe. Se ninguém estiver
          online, segue pelo destino de &ldquo;ninguém online&rdquo;.
        </span>
      </span>
    </label>
  );
}

function AgentPickerEditor({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
}: {
  cfg: SendListCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
}) {
  const { teams, loading } = useHandoffOptions();
  const picker = cfg.agent_picker ?? {};
  const sections = cfg.sections ?? [];
  const rows = sections.flatMap((s) => s.rows);
  const templateRow = rows.find((r) => r.reply_id !== PICKER_NO_AGENT_REPLY_ID);
  const noAgentRow = rows.find((r) => r.reply_id === PICKER_NO_AGENT_REPLY_ID);

  const setRowNext = (replyId: string, nextKey: string) =>
    onUpdateConfig({
      sections: sections.map((s) => ({
        ...s,
        rows: s.rows.map((r) => (r.reply_id === replyId ? { ...r, next_node_key: nextKey } : r)),
      })),
    });
  const setPicker = (patch: { team_id?: string; max_options?: number }) =>
    onUpdateConfig({ agent_picker: { ...picker, ...patch } });

  // O destino de quem escolheu precisa ser um "Transferir para atendente"
  // com "atribuir ao operador escolhido" ligado — senão o cliente escolhe e
  // ninguém recebe a conversa.
  const target = templateRow?.next_node_key ? allNodes.find((n) => n.node_key === templateRow.next_node_key) : null;
  const targetOk =
    target?.node_type === "handoff_agent" &&
    (target.config as { assign_from_var?: string } | undefined)?.assign_from_var === PICKER_CHOSEN_VAR;

  return (
    <div className="mt-2 flex flex-col gap-3 rounded-md border border-border p-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Equipe dos operadores</label>
          <Select
            value={picker.team_id ?? HANDOFF_ANY_TEAM}
            onValueChange={(v) => setPicker({ team_id: v && v !== HANDOFF_ANY_TEAM ? v : undefined })}
            disabled={loading}
          >
            <SelectTrigger className="w-full bg-muted">
              <SelectValue placeholder="Toda a conta">
                {picker.team_id ? teams.find((t) => t.id === picker.team_id)?.name ?? "Equipe" : "Toda a conta"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={HANDOFF_ANY_TEAM}>Toda a conta</SelectItem>
              {teams.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Máximo de operadores no menu (1–10)</label>
          <Input
            type="number"
            min={1}
            max={PICKER_MAX_OPTIONS}
            value={picker.max_options ?? PICKER_MAX_OPTIONS}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value));
              if (Number.isFinite(n)) setPicker({ max_options: Math.min(PICKER_MAX_OPTIONS, Math.max(1, n)) });
            }}
            className="bg-muted"
          />
        </div>
      </div>
      {templateRow && (
        <div>
          <NextNodeRow
            label="Quem escolheu um operador vai para"
            value={templateRow.next_node_key}
            allNodes={allNodes}
            currentKey={currentKey}
            onChange={(v) => setRowNext(templateRow.reply_id, v)}
          />
          {!targetOk && (
            <p className="mt-1.5 text-xs text-warning">
              Use um nó &ldquo;Transferir para atendente&rdquo; com &ldquo;Atribuir ao operador escolhido no menu&rdquo; ligado.
            </p>
          )}
        </div>
      )}
      {noAgentRow ? (
        <NextNodeRow
          label="Se ninguém estiver online, vai para"
          value={noAgentRow.next_node_key}
          allNodes={allNodes}
          currentKey={currentKey}
          onChange={(v) => setRowNext(PICKER_NO_AGENT_REPLY_ID, v)}
        />
      ) : (
        <p className="text-xs text-muted-foreground">Sem destino para &ldquo;ninguém online&rdquo;: a conversa vai para a fila normal da equipe.</p>
      )}
    </div>
  );
}

// ============================================================
// condition
// ============================================================

interface ConditionCfg {
  subject?: "var" | "tag" | "contact_field";
  subject_key?: string;
  operator?: "equals" | "contains" | "present" | "absent";
  value?: string;
  true_next?: string;
  false_next?: string;
}

interface UserTag {
  id: string;
  name: string;
  color?: string;
}

function ConditionForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
}: {
  cfg: ConditionCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
}) {
  const tags = useUserTags();

  const subject = cfg.subject ?? "var";
  const operator = cfg.operator ?? "equals";
  const showValue = operator === "equals" || operator === "contains";

  return (
    <>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Se</label>
          <Select
            value={subject}
            onValueChange={(v) =>
              onUpdateConfig({ subject: v as ConditionCfg["subject"] })
            }
          >
            <SelectTrigger className="bg-muted">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="var">Variável capturada</SelectItem>
              <SelectItem value="tag">Contato tem a tag</SelectItem>
              <SelectItem value="contact_field">Campo do contato</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="md:col-span-2">
          <label className="mb-1 block text-xs text-muted-foreground">
            {subject === "var"
              ? "nome da var"
              : subject === "tag"
                ? "Tag"
                : "Campo"}
          </label>
          {subject === "tag" && tags.length > 0 ? (
            <Select
              value={cfg.subject_key ?? ""}
              onValueChange={(v) => onUpdateConfig({ subject_key: v })}
            >
              <SelectTrigger className="bg-muted">
                <SelectValue placeholder="Escolha uma tag…" />
              </SelectTrigger>
              <SelectContent>
                {tags.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : subject === "contact_field" ? (
            <Select
              value={cfg.subject_key ?? ""}
              onValueChange={(v) => onUpdateConfig({ subject_key: v })}
            >
              <SelectTrigger className="bg-muted">
                <SelectValue placeholder="Escolha um campo…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="name">Nome</SelectItem>
                <SelectItem value="email">E-mail</SelectItem>
                <SelectItem value="phone">Telefone</SelectItem>
                <SelectItem value="company">Empresa</SelectItem>
              </SelectContent>
            </Select>
          ) : (
            <Input
              value={cfg.subject_key ?? ""}
              onChange={(e) =>
                onUpdateConfig({ subject_key: e.target.value })
              }
              placeholder={subject === "var" ? "ex.: email" : "ID da etiqueta"}
              className="bg-muted font-mono text-xs"
            />
          )}
        </div>
      </div>

      <div
        className={cn(
          "grid grid-cols-1 gap-3",
          showValue ? "md:grid-cols-2" : "",
        )}
      >
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Operador</label>
          <Select
            value={operator}
            onValueChange={(v) =>
              onUpdateConfig({ operator: v as ConditionCfg["operator"] })
            }
          >
            <SelectTrigger className="bg-muted">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="present">está presente</SelectItem>
              <SelectItem value="absent">está ausente</SelectItem>
              <SelectItem value="equals">é igual a</SelectItem>
              <SelectItem value="contains">contém</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {showValue && (
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Valor</label>
            <Input
              value={cfg.value ?? ""}
              onChange={(e) => onUpdateConfig({ value: e.target.value })}
              className="bg-muted"
            />
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <NextNodeRow
          value={cfg.true_next ?? ""}
          allNodes={allNodes}
          currentKey={currentKey}
          onChange={(v) => onUpdateConfig({ true_next: v })}
          label="Se verdadeiro → avança para"
        />
        <NextNodeRow
          value={cfg.false_next ?? ""}
          allNodes={allNodes}
          currentKey={currentKey}
          onChange={(v) => onUpdateConfig({ false_next: v })}
          label="Se falso → avança para"
        />
      </div>
    </>
  );
}

// ============================================================
// switch
//
// Generalizes `condition`: N branches, each with its own set of
// subject/operator/value predicates combined by AND or OR, evaluated
// in order; a fixed non-removable "Senão" branch at the end carries
// no conditions of its own — just a destination for when nothing
// above matched.
// ============================================================

interface SwitchConditionCfg {
  subject?: "var" | "tag" | "contact_field";
  subject_key?: string;
  operator?: "equals" | "contains" | "present" | "absent";
  value?: string;
}

interface SwitchBranchCfg {
  id: string;
  label?: string;
  combinator?: "and" | "or";
  conditions?: SwitchConditionCfg[];
  next_node_key?: string;
}

interface SwitchCfg {
  branches?: SwitchBranchCfg[];
  default_next?: string;
}

function newSwitchCondition(): SwitchConditionCfg {
  return { subject: "var", subject_key: "", operator: "equals", value: "" };
}

function newSwitchBranch(index: number): SwitchBranchCfg {
  return {
    id: crypto.randomUUID(),
    label: `Ramo ${index + 1}`,
    combinator: "and",
    conditions: [newSwitchCondition()],
    next_node_key: "",
  };
}

function SwitchForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
}: {
  cfg: SwitchCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
}) {
  const tags = useUserTags();
  const branches = cfg.branches ?? [];

  const updateBranch = (idx: number, patch: Partial<SwitchBranchCfg>) => {
    onUpdateConfig({
      branches: branches.map((b, i) => (i === idx ? { ...b, ...patch } : b)),
    });
  };
  const addBranch = () =>
    onUpdateConfig({
      branches: [...branches, newSwitchBranch(branches.length)],
    });
  const removeBranch = (idx: number) =>
    onUpdateConfig({ branches: branches.filter((_, i) => i !== idx) });

  const updateCondition = (
    branchIdx: number,
    condIdx: number,
    patch: Partial<SwitchConditionCfg>,
  ) => {
    const conditions = branches[branchIdx].conditions ?? [];
    updateBranch(branchIdx, {
      conditions: conditions.map((c, i) =>
        i === condIdx ? { ...c, ...patch } : c,
      ),
    });
  };
  const addCondition = (branchIdx: number) => {
    const conditions = branches[branchIdx].conditions ?? [];
    updateBranch(branchIdx, {
      conditions: [...conditions, newSwitchCondition()],
    });
  };
  const removeCondition = (branchIdx: number, condIdx: number) => {
    const conditions = branches[branchIdx].conditions ?? [];
    updateBranch(branchIdx, {
      conditions: conditions.filter((_, i) => i !== condIdx),
    });
  };

  return (
    <>
      <div className="flex flex-col gap-4">
        {branches.map((branch, bIdx) => {
          const conditions = branch.conditions ?? [];
          return (
            <div
              key={branch.id}
              className="rounded-md border border-border bg-muted/40 p-3"
            >
              <div className="mb-3 flex items-center gap-2">
                <Input
                  value={branch.label ?? ""}
                  onChange={(e) =>
                    updateBranch(bIdx, { label: e.target.value })
                  }
                  placeholder={`Ramo ${bIdx + 1}`}
                  className="bg-muted text-sm font-medium"
                />
                {branches.length > 1 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeBranch(bIdx)}
                    className="shrink-0 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                    aria-label="Remover ramo"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>

              {conditions.length > 1 && (
                <div className="mb-2 max-w-48">
                  <label className="mb-1 block text-xs text-muted-foreground">
                    Combinar condições com
                  </label>
                  <Select
                    value={branch.combinator ?? "and"}
                    onValueChange={(v) =>
                      updateBranch(bIdx, { combinator: v as "and" | "or" })
                    }
                  >
                    <SelectTrigger className="bg-muted">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="and">E (todas as condições)</SelectItem>
                      <SelectItem value="or">OU (qualquer uma)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="flex flex-col gap-2">
                {conditions.map((cond, cIdx) => (
                  <SwitchConditionRow
                    key={cIdx}
                    cond={cond}
                    tags={tags}
                    onChange={(patch) => updateCondition(bIdx, cIdx, patch)}
                    onRemove={
                      conditions.length > 1
                        ? () => removeCondition(bIdx, cIdx)
                        : undefined
                    }
                  />
                ))}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => addCondition(bIdx)}
                className="mt-1"
              >
                <Plus className="h-3.5 w-3.5" />
                Adicionar condição
              </Button>

              <div className="mt-3">
                <NextNodeRow
                  value={branch.next_node_key ?? ""}
                  allNodes={allNodes}
                  currentKey={currentKey}
                  onChange={(v) => updateBranch(bIdx, { next_node_key: v })}
                  label="Se este ramo passar → avança para"
                />
              </div>
            </div>
          );
        })}
      </div>

      <Button variant="outline" size="sm" onClick={addBranch} className="mt-3">
        <Plus className="h-3.5 w-3.5" />
        Adicionar ramo
      </Button>

      {/* Fixed "Senão" branch — no conditions of its own, not removable;
          the validator requires this to be filled independently of the
          branches above. */}
      <div className="mt-3 rounded-md border border-border bg-muted/40 p-3">
        <p className="mb-2 text-xs font-medium text-muted-foreground">
          Senão
        </p>
        <NextNodeRow
          value={cfg.default_next ?? ""}
          allNodes={allNodes}
          currentKey={currentKey}
          onChange={(v) => onUpdateConfig({ default_next: v })}
          label="Se nenhum ramo passar → avança para"
        />
      </div>
    </>
  );
}

function SwitchConditionRow({
  cond,
  tags,
  onChange,
  onRemove,
}: {
  cond: SwitchConditionCfg;
  tags: UserTag[];
  onChange: (patch: Partial<SwitchConditionCfg>) => void;
  onRemove?: () => void;
}) {
  const subject = cond.subject ?? "var";
  const operator = cond.operator ?? "equals";
  const showValue = operator === "equals" || operator === "contains";

  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-2 rounded border border-border/60 bg-background/40 p-2",
        showValue
          ? "md:grid-cols-[1fr_1.4fr_1fr_1fr_auto]"
          : "md:grid-cols-[1fr_1.4fr_1fr_auto]",
      )}
    >
      <Select
        value={subject}
        onValueChange={(v) =>
          onChange({ subject: v as SwitchConditionCfg["subject"] })
        }
      >
        <SelectTrigger className="bg-muted">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="var">Variável</SelectItem>
          <SelectItem value="tag">Tag</SelectItem>
          <SelectItem value="contact_field">Campo</SelectItem>
        </SelectContent>
      </Select>

      {subject === "tag" && tags.length > 0 ? (
        <Select
          value={cond.subject_key ?? ""}
          onValueChange={(v) => onChange({ subject_key: v ?? "" })}
        >
          <SelectTrigger className="bg-muted">
            <SelectValue placeholder="Escolha uma tag…" />
          </SelectTrigger>
          <SelectContent>
            {tags.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : subject === "contact_field" ? (
        <Select
          value={cond.subject_key ?? ""}
          onValueChange={(v) => onChange({ subject_key: v ?? "" })}
        >
          <SelectTrigger className="bg-muted">
            <SelectValue placeholder="Escolha um campo…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="name">Nome</SelectItem>
            <SelectItem value="email">E-mail</SelectItem>
            <SelectItem value="phone">Telefone</SelectItem>
            <SelectItem value="company">Empresa</SelectItem>
          </SelectContent>
        </Select>
      ) : (
        <Input
          value={cond.subject_key ?? ""}
          onChange={(e) => onChange({ subject_key: e.target.value })}
          placeholder={subject === "var" ? "ex.: email" : "ID da etiqueta"}
          className="bg-muted font-mono text-xs"
        />
      )}

      <Select
        value={operator}
        onValueChange={(v) =>
          onChange({ operator: v as SwitchConditionCfg["operator"] })
        }
      >
        <SelectTrigger className="bg-muted">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="present">está presente</SelectItem>
          <SelectItem value="absent">está ausente</SelectItem>
          <SelectItem value="equals">é igual a</SelectItem>
          <SelectItem value="contains">contém</SelectItem>
        </SelectContent>
      </Select>

      {showValue && (
        <Input
          value={cond.value ?? ""}
          onChange={(e) => onChange({ value: e.target.value })}
          placeholder="Valor"
          className="bg-muted"
        />
      )}

      {onRemove && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onRemove}
          className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
          aria-label="Remover condição"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

// ============================================================
// set_tag
// ============================================================

interface SetTagCfg {
  mode?: "add" | "remove";
  tag_id?: string;
  next_node_key?: string;
}

function SetTagForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
}: {
  cfg: SetTagCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
}) {
  const tags = useUserTags();

  return (
    <>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Ação</label>
          <Select
            value={cfg.mode ?? "add"}
            onValueChange={(v) =>
              onUpdateConfig({ mode: v as SetTagCfg["mode"] })
            }
          >
            <SelectTrigger className="bg-muted">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="add">Adicionar tag</SelectItem>
              <SelectItem value="remove">Remover tag</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Tag</label>
          {tags.length > 0 ? (
            <Select
              value={cfg.tag_id ?? ""}
              onValueChange={(v) => onUpdateConfig({ tag_id: v })}
            >
              <SelectTrigger className="bg-muted">
                <SelectValue placeholder="Escolha uma tag…" />
              </SelectTrigger>
              <SelectContent>
                {tags.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              value={cfg.tag_id ?? ""}
              onChange={(e) => onUpdateConfig({ tag_id: e.target.value })}
              placeholder="ID da etiqueta"
              className="bg-muted font-mono text-xs"
            />
          )}
        </div>
      </div>
      <NextNodeRow
        value={cfg.next_node_key ?? ""}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label="Depois, avança para"
      />
    </>
  );
}

/**
 * Shared loader for both `condition` (subject=tag) and `set_tag`.
 * Falls back to raw UUID input if the endpoint is absent on older
 * deployments — the form remains authorable in that case.
 */
function useUserTags(): UserTag[] {
  const [tags, setTags] = useState<UserTag[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch("/api/tags").catch(() => null);
        if (!res || !res.ok) return;
        const json = (await res.json()) as { tags?: UserTag[] };
        if (!cancelled) setTags(json.tags ?? []);
      } catch {
        // Tags endpoint absent — caller falls back to raw input.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return tags;
}

// ============================================================
// handoff
// ============================================================

interface HandoffCfg {
  reason_code?: string;
  reason_subcode?: string;
  note?: string;
  assign_to?: string;
  team_id?: string;
}

interface HandoffTeamOption {
  id: string;
  name: string;
}

interface HandoffAgentOption {
  user_id: string;
  full_name: string;
}

const HANDOFF_ANY_TEAM = "__any_team__";
const HANDOFF_ANY_AGENT = "__any_agent__";

const HANDOFF_REASON_CODES = [
  "CLIENTE_PEDIU_HUMANO",
  "CPF_INVALIDO",
  "CPF_NAO_LOCALIZADO",
  "CPF_NAO_INFORMADO",
  "DEBITO_NAO_LOCALIZADO",
  "DADOS_INCONSISTENTES",
  "RECUSA_PRECO",
  "RECUSA_SEM_RECURSOS",
  "RECUSA_NAO_RECONHECE_DIVIDA",
  "RECUSA_OUTRO",
  "AGENDAMENTO",
  "TOOL_TIMEOUT",
  "TOOL_ERROR",
  "ACORDO_EXISTENTE",
  "ERRO_EFETIVACAO",
  "EXCECAO_COMERCIAL",
  "CONTESTACAO_DIVIDA",
  "FALLBACK_EXAURIDO",
  "INDEFINIDO",
] as const;

function HandoffReasonFields({
  reasonCode,
  reasonSubcode,
  onUpdateConfig,
}: {
  reasonCode?: string;
  reasonSubcode?: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">
          Motivo estruturado
        </label>
        <Select
          value={reasonCode || "INDEFINIDO"}
          onValueChange={(v) => onUpdateConfig({ reason_code: v })}
        >
          <SelectTrigger className="bg-muted">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {HANDOFF_REASON_CODES.map((reason) => (
              <SelectItem key={reason} value={reason}>
                {reason}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">
          Submotivo (opcional)
        </label>
        <Input
          value={reasonSubcode ?? ""}
          onChange={(e) =>
            onUpdateConfig({
              reason_subcode: e.target.value
                .toUpperCase()
                .replace(/[^A-Z0-9_]/g, "_"),
            })
          }
          placeholder="ex.: API_TIMEOUT_APOS_RETRY"
          className="bg-muted font-mono text-xs"
        />
      </div>
    </div>
  );
}

/**
 * Loads the account's teams + agents for the handoff node's Selects.
 * `teams` and `profiles` allow any account member to SELECT (migrations
 * 049 / 017), and `team_members` does too (migration 062), so this
 * queries Supabase directly — same pattern as MembersTab's team roster
 * load — no dedicated API route.
 *
 * Agent↔team membership comes from `wacrm.team_members` (many-to-many),
 * NOT the deprecated scalar `profiles.team_id` — an agent can belong to
 * more than one team.
 *
 * `agents` is filtered to account_role='agent' — admins/owners must not
 * be selectable as a fixed handoff_agent target, same rule the automatic
 * assignment already enforces (selectAgentForTeam/selectAnyAgentForAccount
 * in src/lib/flows/engine.ts).
 */
function useHandoffOptions(): {
  teams: HandoffTeamOption[];
  agents: HandoffAgentOption[];
  teamMembersMap: Record<string, string[]>;
  loading: boolean;
} {
  const { accountId } = useAuth();
  const [teams, setTeams] = useState<HandoffTeamOption[]>([]);
  const [agents, setAgents] = useState<HandoffAgentOption[]>([]);
  const [teamMembersMap, setTeamMembersMap] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const supabase = createClient();
    (async () => {
      setLoading(true);
      const [tRes, aRes] = await Promise.all([
        supabase
          .from("teams")
          .select("id, name")
          .eq("account_id", accountId)
          .order("name"),
        supabase
          .from("profiles")
          .select("user_id, full_name")
          .eq("account_id", accountId)
          .eq("account_role", "agent")
          .order("full_name"),
      ]);
      if (cancelled) return;
      if (tRes.error) {
        console.error("[HandoffForm] teams load error:", tRes.error);
      } else {
        setTeams((tRes.data ?? []) as HandoffTeamOption[]);
      }
      if (aRes.error) {
        console.error("[HandoffForm] agents load error:", aRes.error);
      } else {
        setAgents(
          (aRes.data ?? []).map((row) => ({
            user_id: (row as { user_id: string }).user_id,
            full_name: (row as { full_name: string | null }).full_name || "Sem nome",
          })),
        );
      }

      const teamIds = ((tRes.data ?? []) as HandoffTeamOption[]).map((t) => t.id);
      if (teamIds.length > 0) {
        const mRes = await supabase
          .from("team_members")
          .select("team_id, user_id")
          .in("team_id", teamIds);
        if (cancelled) return;
        if (mRes.error) {
          console.error("[HandoffForm] team members load error:", mRes.error);
        } else {
          const map: Record<string, string[]> = {};
          for (const row of (mRes.data ?? []) as { team_id: string; user_id: string }[]) {
            (map[row.team_id] ??= []).push(row.user_id);
          }
          setTeamMembersMap(map);
        }
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  return { teams, agents, teamMembersMap, loading };
}

function HandoffForm({
  cfg,
  onUpdateConfig,
}: {
  cfg: HandoffCfg;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
}) {
  const { teams, agents, teamMembersMap, loading } = useHandoffOptions();
  const teamId = cfg.team_id ?? "";
  const agentId = cfg.assign_to ?? "";
  const agentOptions = teamId
    ? agents.filter((a) => (teamMembersMap[teamId] ?? []).includes(a.user_id))
    : agents;

  // Precomputed as plain strings (not a SelectValue render-prop) so the
  // trigger's closed-state text is always the resolved name, never the
  // raw id — SelectValue's own store-driven label resolution is what
  // was leaking the UUID.
  const teamLabel = teamId
    ? teams.find((t) => t.id === teamId)?.name ?? "Qualquer equipe"
    : "Qualquer equipe";
  const agentLabel = agentId
    ? agents.find((a) => a.user_id === agentId)?.full_name ??
      "Qualquer agente disponível"
    : "Qualquer agente disponível";

  return (
    <>
      <HandoffReasonFields
        reasonCode={cfg.reason_code}
        reasonSubcode={cfg.reason_subcode}
        onUpdateConfig={onUpdateConfig}
      />
      <div className="flex flex-col gap-3">
        <div className="w-full">
          <label className="mb-1 block text-xs text-muted-foreground">Equipe</label>
          <Select
            value={teamId || HANDOFF_ANY_TEAM}
            onValueChange={(v) => {
              const nextTeamId = v === HANDOFF_ANY_TEAM ? undefined : v;
              // Switching team drops an agent pick that no longer
              // belongs to it, same UX as the Monitoramento transfer
              // dialog's independent-but-filtered fields.
              const patch: Record<string, unknown> = { team_id: nextTeamId };
              if (
                nextTeamId &&
                agentId &&
                !(teamMembersMap[nextTeamId] ?? []).includes(agentId)
              ) {
                patch.assign_to = undefined;
              }
              onUpdateConfig(patch);
            }}
            disabled={loading}
          >
            <SelectTrigger className="w-full bg-muted">
              <SelectValue placeholder="Qualquer equipe">
                {loading ? "Carregando…" : teamLabel}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={HANDOFF_ANY_TEAM}>Qualquer equipe</SelectItem>
              {teams.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-full">
          <label className="mb-1 block text-xs text-muted-foreground">Agente</label>
          <Select
            value={agentId || HANDOFF_ANY_AGENT}
            onValueChange={(v) =>
              onUpdateConfig({ assign_to: v === HANDOFF_ANY_AGENT ? undefined : v })
            }
            disabled={loading}
          >
            <SelectTrigger className="w-full bg-muted">
              <SelectValue placeholder="Qualquer agente disponível">
                {loading ? "Carregando…" : agentLabel}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={HANDOFF_ANY_AGENT}>
                Qualquer agente disponível
              </SelectItem>
              {agentOptions.map((a) => (
                <SelectItem key={a.user_id} value={a.user_id}>
                  {a.full_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <TextRow
        label="Nota interna (para o agente que assumir)"
        value={cfg.note ?? ""}
        onChange={(v) => onUpdateConfig({ note: v })}
        rows={2}
      />
    </>
  );
}

// ============================================================
// handoff_agent — "Transferir para Operador": note + agent selector
// only, no team selector.
// ============================================================

interface HandoffAgentCfg {
  reason_code?: string;
  reason_subcode?: string;
  note?: string;
  assign_to?: string;
  /** "chosen_agent_id" = atribui ao operador escolhido no menu de operadores (PRD 23, item 16). */
  assign_from_var?: string;
}

function HandoffAgentForm({
  cfg,
  onUpdateConfig,
}: {
  cfg: HandoffAgentCfg;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
}) {
  const { agents, loading } = useHandoffOptions();
  const agentId = cfg.assign_to ?? "";
  const agentLabel = agentId
    ? agents.find((a) => a.user_id === agentId)?.full_name ??
      "Qualquer agente disponível"
    : "Qualquer agente disponível";

  return (
    <>
      <HandoffReasonFields
        reasonCode={cfg.reason_code}
        reasonSubcode={cfg.reason_subcode}
        onUpdateConfig={onUpdateConfig}
      />
      <div className="w-full">
        <label className="mb-1 block text-xs text-muted-foreground">Agente</label>
        <Select
          value={agentId || HANDOFF_ANY_AGENT}
          onValueChange={(v) =>
            onUpdateConfig({ assign_to: v === HANDOFF_ANY_AGENT ? undefined : v })
          }
          disabled={loading}
        >
          <SelectTrigger className="w-full bg-muted">
            <SelectValue placeholder="Qualquer agente disponível">
              {loading ? "Carregando…" : agentLabel}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={HANDOFF_ANY_AGENT}>
              Qualquer agente disponível
            </SelectItem>
            {agents.map((a) => (
              <SelectItem key={a.user_id} value={a.user_id}>
                {a.full_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {/* Destino do "Menu de operadores online" (item 16 do PRD 23): atribui ao
          operador que o cliente escolheu na lista. Um agente fixo acima vence. */}
      <label className="flex items-start gap-3 rounded-md border border-border bg-card-2 p-3">
        <Switch
          checked={cfg.assign_from_var === PICKER_CHOSEN_VAR}
          onCheckedChange={(on) => onUpdateConfig({ assign_from_var: on ? PICKER_CHOSEN_VAR : undefined })}
          className="mt-0.5"
        />
        <span className="min-w-0">
          <span className="block text-[13px] font-medium text-foreground">Atribuir ao operador escolhido no menu</span>
          <span className="block text-xs text-muted-foreground">
            Use como destino de um &ldquo;Menu de operadores online&rdquo; (lista). Se um agente fixo estiver escolhido acima, ele vale.
          </span>
        </span>
      </label>
      <TextRow
        label="Nota interna (para o agente que assumir)"
        value={cfg.note ?? ""}
        onChange={(v) => onUpdateConfig({ note: v })}
        rows={2}
      />
    </>
  );
}

// ============================================================
// handoff_team — "Transferir para Equipe": note + team selector
// only, no agent selector.
// ============================================================

interface HandoffTeamCfg {
  reason_code?: string;
  reason_subcode?: string;
  note?: string;
  team_id?: string;
}

function HandoffTeamForm({
  cfg,
  onUpdateConfig,
}: {
  cfg: HandoffTeamCfg;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
}) {
  const { teams, loading } = useHandoffOptions();
  const teamId = cfg.team_id ?? "";
  const teamLabel = teamId
    ? teams.find((t) => t.id === teamId)?.name ?? "Qualquer equipe"
    : "Qualquer equipe";

  return (
    <>
      <HandoffReasonFields
        reasonCode={cfg.reason_code}
        reasonSubcode={cfg.reason_subcode}
        onUpdateConfig={onUpdateConfig}
      />
      <div className="w-full">
        <label className="mb-1 block text-xs text-muted-foreground">Equipe</label>
        <Select
          value={teamId || HANDOFF_ANY_TEAM}
          onValueChange={(v) =>
            onUpdateConfig({ team_id: v === HANDOFF_ANY_TEAM ? undefined : v })
          }
          disabled={loading}
        >
          <SelectTrigger className="w-full bg-muted">
            <SelectValue placeholder="Qualquer equipe">
              {loading ? "Carregando…" : teamLabel}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={HANDOFF_ANY_TEAM}>Qualquer equipe</SelectItem>
            {teams.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <TextRow
        label="Nota interna (para quem assumir)"
        value={cfg.note ?? ""}
        onChange={(v) => onUpdateConfig({ note: v })}
        rows={2}
      />
    </>
  );
}

// ============================================================
// send_media
// ============================================================

interface SendMediaCfg {
  media_type?: "image" | "video" | "document";
  media_url?: string;
  caption?: string;
  filename?: string;
  next_node_key?: string;
}

// Mirrors the bucket's allowed_mime_types from migration 016. Kept in
// sync with the storage policy so the picker rejects unsupported files
// before they hit the network rather than failing with a confusing
// Supabase RLS / mime-type error.
const MEDIA_ACCEPT: Record<NonNullable<SendMediaCfg["media_type"]>, string> = {
  image: "image/png,image/jpeg,image/webp",
  video: "video/mp4,video/3gpp",
  document:
    "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain",
};

const FLOW_MEDIA_BUCKET = "flow-media";

function SendMediaForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
}: {
  cfg: SendMediaCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const mediaType = cfg.media_type ?? "image";
  const isDocument = mediaType === "document";
  const displayName =
    cfg.filename ||
    (cfg.media_url ? cfg.media_url.split("/").pop() ?? "" : "");

  const handleFile = useCallback(
    async (file: File) => {
      if (file.size > MEDIA_MAX_BYTES) {
        toast.error(
          `O arquivo tem ${(file.size / 1024 / 1024).toFixed(1)} MB — o limite é 16 MB.`,
        );
        return;
      }
      setUploading(true);
      try {
        // Account-scoped upload (path `account-<id>/...`) — see
        // uploadAccountMedia + migration 020's flow-media RLS policy.
        const { publicUrl } = await uploadAccountMedia(FLOW_MEDIA_BUCKET, file);
        // Patch all fields in one call so the form doesn't re-render
        // with a half-uploaded state.
        onUpdateConfig({
          media_url: publicUrl,
          filename: file.name,
        });
        toast.success("Arquivo enviado.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Falha no envio.";
        toast.error(msg);
      } finally {
        setUploading(false);
      }
    },
    [onUpdateConfig],
  );

  const handleClear = () => {
    onUpdateConfig({ media_url: "", filename: "" });
  };

  return (
    <>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">Tipo de mídia</label>
        <Select
          value={mediaType}
          onValueChange={(v) => {
            // Changing type clears the existing file — the bucket
            // accepts different MIME sets per type and a previously
            // uploaded PDF can't be sent as an image.
            onUpdateConfig({
              media_type: v as NonNullable<SendMediaCfg["media_type"]>,
              media_url: "",
              filename: "",
            });
          }}
        >
          <SelectTrigger className="bg-muted">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="image">Imagem (PNG, JPEG, WebP)</SelectItem>
            <SelectItem value="video">Vídeo (MP4, 3GP)</SelectItem>
            <SelectItem value="document">
              Documento (PDF, Word, Excel, PowerPoint, TXT)
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div>
        <label className="mb-1 block text-xs text-muted-foreground">Arquivo</label>
        {cfg.media_url ? (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs">
            <Paperclip className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
            <a
              href={cfg.media_url}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 flex-1 truncate text-foreground hover:text-cyan-300"
              title={displayName || cfg.media_url}
            >
              {displayName || cfg.media_url}
            </a>
            <button
              type="button"
              onClick={handleClear}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Remover arquivo"
              disabled={uploading}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border bg-card px-3 py-4 text-xs text-muted-foreground transition-colors hover:border-border hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            {uploading ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Enviando…
              </>
            ) : (
              <>
                <Upload className="h-3.5 w-3.5" />
                Clique para enviar (máx. 16 MB)
              </>
            )}
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept={MEDIA_ACCEPT[mediaType]}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            // Reset so picking the same file twice still fires onChange.
            e.target.value = "";
          }}
        />
      </div>

      <TextRow
        label="Legenda (opcional, exibida abaixo da mídia)"
        value={cfg.caption ?? ""}
        onChange={(v) => onUpdateConfig({ caption: v })}
        rows={2}
      />

      {isDocument && (
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            Nome do arquivo mostrado ao cliente (somente documentos)
          </label>
          <Input
            value={cfg.filename ?? ""}
            onChange={(e) => onUpdateConfig({ filename: e.target.value })}
            placeholder="invoice.pdf"
            className="bg-muted text-xs"
          />
        </div>
      )}

      <NextNodeRow
        value={cfg.next_node_key ?? ""}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label="Depois de enviar, avança para"
      />
    </>
  );
}

// ============================================================
// http_fetch
// ============================================================

interface HttpFetchCfg {
  url?: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body_template?: string;
  response_var?: string;
  timeout_seconds?: number;
  next_node_key?: string;
}

function HttpFetchForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
}: {
  cfg: HttpFetchCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
}) {
  const method = cfg.method ?? "GET";
  // Headers are edited as raw JSON text — buffered in local state so
  // an in-progress edit (temporarily invalid JSON) doesn't get
  // clobbered by re-deriving from cfg.headers on every keystroke.
  const [headersText, setHeadersText] = useState(() =>
    JSON.stringify(cfg.headers ?? {}, null, 2),
  );
  const [headersError, setHeadersError] = useState<string | null>(null);

  return (
    <>
      <TextRow
        label="URL"
        value={cfg.url ?? ""}
        onChange={(v) => onUpdateConfig({ url: v })}
      />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Método</label>
          <Select
            value={method}
            onValueChange={(v) =>
              onUpdateConfig({ method: v as HttpFetchCfg["method"] })
            }
          >
            <SelectTrigger className="bg-muted">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="GET">GET</SelectItem>
              <SelectItem value="POST">POST</SelectItem>
              <SelectItem value="PUT">PUT</SelectItem>
              <SelectItem value="PATCH">PATCH</SelectItem>
              <SelectItem value="DELETE">DELETE</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            Timeout (segundos)
          </label>
          <Input
            type="number"
            min={1}
            max={30}
            value={cfg.timeout_seconds ?? 10}
            onChange={(e) => {
              const n = Number(e.target.value);
              onUpdateConfig({
                timeout_seconds: Number.isFinite(n) ? Math.min(30, Math.max(1, n)) : 10,
              });
            }}
            className="bg-muted"
          />
        </div>
      </div>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">
          Cabeçalhos (JSON, opcional)
        </label>
        <Textarea
          value={headersText}
          onChange={(e) => {
            const text = e.target.value;
            setHeadersText(text);
            if (!text.trim()) {
              setHeadersError(null);
              onUpdateConfig({ headers: {} });
              return;
            }
            try {
              const parsed = JSON.parse(text);
              setHeadersError(null);
              onUpdateConfig({ headers: parsed });
            } catch {
              setHeadersError("JSON inválido — corrija antes de ativar o fluxo.");
            }
          }}
          rows={3}
          className="bg-muted font-mono text-xs"
        />
        {headersError && (
          <p className="mt-1 text-[10px] text-red-400">{headersError}</p>
        )}
      </div>
      {method !== "GET" && (
        <TextRow
          label="Corpo (aceita {{vars.X}})"
          value={cfg.body_template ?? ""}
          onChange={(v) => onUpdateConfig({ body_template: v })}
          rows={3}
        />
      )}
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">
          Variável para guardar a resposta (opcional)
        </label>
        <Input
          value={cfg.response_var ?? ""}
          onChange={(e) =>
            onUpdateConfig({
              response_var: e.target.value.replace(/[^a-zA-Z0-9_]/g, ""),
            })
          }
          placeholder="ex.: resposta_api"
          className="bg-muted font-mono text-xs"
        />
      </div>
      <NextNodeRow
        value={cfg.next_node_key ?? ""}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label="Depois da chamada, avança para"
      />
    </>
  );
}

// ============================================================
// set_variable
// ============================================================

interface SetVariableCfg {
  assignments?: Array<{ variable: string; value: string }>;
  next_node_key?: string;
}

function SetVariableForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
}: {
  cfg: SetVariableCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
}) {
  const assignments = cfg.assignments ?? [];
  const updateAssignment = (
    idx: number,
    patch: Partial<{ variable: string; value: string }>,
  ) => {
    onUpdateConfig({
      assignments: assignments.map((a, i) => (i === idx ? { ...a, ...patch } : a)),
    });
  };
  const addAssignment = () =>
    onUpdateConfig({
      assignments: [...assignments, { variable: "", value: "" }],
    });
  const removeAssignment = (idx: number) =>
    onUpdateConfig({ assignments: assignments.filter((_, i) => i !== idx) });

  return (
    <>
      <div>
        <label className="mb-2 block text-xs text-muted-foreground">
          Variáveis a gravar no fluxo (o valor aceita {"{{vars.X}}"})
        </label>
        <div className="flex flex-col gap-2">
          {assignments.map((a, i) => (
            <div
              key={i}
              className="grid grid-cols-1 gap-2 rounded-md border border-border bg-muted/40 p-3 md:grid-cols-[1fr_2fr_auto]"
            >
              <Input
                value={a.variable}
                onChange={(e) =>
                  updateAssignment(i, {
                    variable: e.target.value.replace(/[^a-zA-Z0-9_]/g, ""),
                  })
                }
                placeholder="variável"
                className="bg-muted font-mono text-xs"
              />
              <Input
                value={a.value}
                onChange={(e) => updateAssignment(i, { value: e.target.value })}
                placeholder="valor"
                className="bg-muted"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeAssignment(i)}
                className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
        <Button variant="ghost" size="sm" onClick={addAssignment} className="mt-2">
          <Plus className="h-3.5 w-3.5" />
          Adicionar variável
        </Button>
      </div>
      <NextNodeRow
        value={cfg.next_node_key ?? ""}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label="Avança para"
      />
    </>
  );
}

// ============================================================
// smart_delay
// ============================================================

type DelayUnit = "seconds" | "minutes" | "hours";
const DELAY_UNIT_SECONDS: Record<DelayUnit, number> = {
  seconds: 1,
  minutes: 60,
  hours: 3600,
};

function guessDelayUnit(totalSeconds: number): DelayUnit {
  if (totalSeconds > 0 && totalSeconds % 3600 === 0) return "hours";
  if (totalSeconds > 0 && totalSeconds % 60 === 0) return "minutes";
  return "seconds";
}

interface SmartDelayCfg {
  delay_seconds?: number;
  message?: string;
  next_node_key?: string;
}

function SmartDelayForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
}: {
  cfg: SmartDelayCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
}) {
  const totalSeconds = cfg.delay_seconds ?? 60;
  // Local-only display unit — the config only ever stores delay_seconds.
  const [unit, setUnit] = useState<DelayUnit>(() => guessDelayUnit(totalSeconds));
  const displayValue = Math.max(1, Math.round(totalSeconds / DELAY_UNIT_SECONDS[unit]));

  return (
    <>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Esperar</label>
          <Input
            type="number"
            min={1}
            value={displayValue}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n > 0) {
                onUpdateConfig({
                  delay_seconds: Math.min(86400, Math.round(n * DELAY_UNIT_SECONDS[unit])),
                });
              }
            }}
            className="bg-muted"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Unidade</label>
          <Select
            value={unit}
            onValueChange={(v) => {
              const nextUnit = v as DelayUnit;
              setUnit(nextUnit);
              onUpdateConfig({
                delay_seconds: Math.min(
                  86400,
                  Math.round(displayValue * DELAY_UNIT_SECONDS[nextUnit]),
                ),
              });
            }}
          >
            <SelectTrigger className="bg-muted">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="seconds">Segundos</SelectItem>
              <SelectItem value="minutes">Minutos</SelectItem>
              <SelectItem value="hours">Horas</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <p className="text-[10px] text-muted-foreground">Máximo de 24 horas (86400s).</p>
      <TextRow
        label="Mensagem antes de esperar (opcional)"
        value={cfg.message ?? ""}
        onChange={(v) => onUpdateConfig({ message: v })}
        rows={2}
      />
      <NextNodeRow
        value={cfg.next_node_key ?? ""}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label="Depois de esperar, avança para"
      />
    </>
  );
}

// ============================================================
// go_to_flow
// ============================================================

interface GoToFlowCfg {
  flow_id?: string;
  pass_vars?: boolean;
}

interface ActiveFlowOption {
  id: string;
  name: string;
}

/** Active flows the current account can transfer into via go_to_flow. */
function useActiveFlows(): { flows: ActiveFlowOption[]; loading: boolean } {
  const [flows, setFlows] = useState<ActiveFlowOption[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await apiFetch("/api/flows").catch(() => null);
        if (!res || !res.ok) return;
        const json = (await res.json()) as {
          flows?: Array<{ id: string; name: string; status: string }>;
        };
        const active = (json.flows ?? [])
          .filter((f) => f.status === "active")
          .map((f) => ({ id: f.id, name: f.name }));
        if (!cancelled) setFlows(active);
      } catch {
        // Leave the picker empty — the empty state below still shows.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return { flows, loading };
}

function GoToFlowForm({
  cfg,
  onUpdateConfig,
}: {
  cfg: GoToFlowCfg;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
}) {
  const { flows, loading } = useActiveFlows();
  const selectedLabel = cfg.flow_id
    ? flows.find((f) => f.id === cfg.flow_id)?.name ?? cfg.flow_id
    : undefined;

  return (
    <>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">
          Fluxo de destino
        </label>
        <Select
          value={cfg.flow_id ?? ""}
          onValueChange={(v) => onUpdateConfig({ flow_id: v })}
          disabled={loading}
        >
          <SelectTrigger className="bg-muted">
            <SelectValue placeholder="Escolha um fluxo ativo…">
              {loading ? "Carregando…" : selectedLabel}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {loading ? (
              <SelectItem value="__loading__" disabled>
                Carregando…
              </SelectItem>
            ) : flows.length === 0 ? (
              <SelectItem value="__empty__" disabled>
                Nenhum fluxo ativo encontrado
              </SelectItem>
            ) : (
              flows.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.name}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
        <p className="mt-1 text-[10px] text-muted-foreground">
          Só fluxos com status &quot;ativo&quot; podem ser escolhidos aqui.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Switch
          checked={cfg.pass_vars ?? true}
          onCheckedChange={(checked) => onUpdateConfig({ pass_vars: checked })}
        />
        <label className="text-xs text-muted-foreground">
          Transferir variáveis capturadas para o novo fluxo
        </label>
      </div>
    </>
  );
}

// ============================================================
// send_template
// ============================================================

interface SendTemplateCfg {
  template_name?: string;
  language_code?: string;
  fallback_text?: string;
  next_node_key?: string;
}

function SendTemplateForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
}: {
  cfg: SendTemplateCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
}) {
  return (
    <>
      <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[10px] text-amber-400">
        Templates (HSM) só funcionam em canais Meta. Em canais WAHA, o texto
        de fallback abaixo é enviado como mensagem comum.
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <TextRow
          label="Nome do template"
          value={cfg.template_name ?? ""}
          onChange={(v) => onUpdateConfig({ template_name: v })}
        />
        <TextRow
          label="Código de idioma"
          value={cfg.language_code ?? "pt_BR"}
          onChange={(v) => onUpdateConfig({ language_code: v })}
        />
      </div>
      <TextRow
        label="Texto de fallback para WAHA (opcional)"
        value={cfg.fallback_text ?? ""}
        onChange={(v) => onUpdateConfig({ fallback_text: v })}
        rows={2}
      />
      <NextNodeRow
        value={cfg.next_node_key ?? ""}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label="Depois de enviar, avança para"
      />
    </>
  );
}

// ============================================================
// send_flow — formulário nativo do WhatsApp (PRD 21.4)
// ============================================================

interface SendFlowCfg {
  flow_id?: string;
  cta_text?: string;
  body_text?: string;
  header_text?: string;
  footer_text?: string;
  screen_id?: string;
  flow_action?: "navigate" | "data_exchange";
  fallback_text?: string;
  next_node_key?: string;
}

const FLOW_ACTION_OPTIONS: Array<{ value: "navigate" | "data_exchange"; label: string }> = [
  { value: "navigate", label: "Abrir direto na tela" },
  { value: "data_exchange", label: "Buscar os dados no CRM (Data Exchange)" },
];

function SendFlowForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
}: {
  cfg: SendFlowCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
}) {
  const action = cfg.flow_action ?? "navigate";
  const vars = "Aceita {{vars.nome_da_variavel}}.";
  return (
    <>
      <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[10px] text-amber-400">
        O formulário (WhatsApp Flow) só funciona em canais Meta. Nos demais canais (WAHA, Webchat…) é enviado o texto
        alternativo abaixo; sem texto alternativo, o fluxo apenas avança. A resposta do cliente volta ao fluxo como
        variáveis (flow_*).
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <TextRow
          label="Id do Flow na Meta (só números)"
          value={cfg.flow_id ?? ""}
          onChange={(v) => onUpdateConfig({ flow_id: v.replace(/\D/g, "") })}
        />
        <TextRow
          label={`Texto do botão que abre o formulário (${(cfg.cta_text ?? "").length}/30)`}
          value={cfg.cta_text ?? ""}
          onChange={(v) => onUpdateConfig({ cta_text: v.slice(0, 30) })}
        />
      </div>
      <TextRow
        label={`Mensagem (obrigatória, até 1024). ${vars}`}
        value={cfg.body_text ?? ""}
        onChange={(v) => onUpdateConfig({ body_text: v })}
        rows={3}
      />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <TextRow
          label={`Título (opcional, até 60). ${vars}`}
          value={cfg.header_text ?? ""}
          onChange={(v) => onUpdateConfig({ header_text: v.slice(0, 60) })}
        />
        <TextRow
          label="Rodapé (opcional, até 60)"
          value={cfg.footer_text ?? ""}
          onChange={(v) => onUpdateConfig({ footer_text: v.slice(0, 60) })}
        />
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Ao abrir o formulário</label>
          <Select
            value={action}
            onValueChange={(v) => v && onUpdateConfig({ flow_action: v as "navigate" | "data_exchange" })}
          >
            <SelectTrigger className="w-full bg-muted">
              <SelectValue>
                {(v: string) => FLOW_ACTION_OPTIONS.find((o) => o.value === v)?.label ?? v}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {FLOW_ACTION_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <TextRow
          label={action === "navigate" ? "Tela inicial (screen_id, obrigatória)" : "Tela inicial (screen_id, opcional)"}
          value={cfg.screen_id ?? ""}
          onChange={(v) => onUpdateConfig({ screen_id: v })}
        />
      </div>
      <TextRow
        label={`Texto alternativo para canais sem formulário (opcional). ${vars}`}
        value={cfg.fallback_text ?? ""}
        onChange={(v) => onUpdateConfig({ fallback_text: v })}
        rows={2}
      />
      <NextNodeRow
        value={cfg.next_node_key ?? ""}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label="Depois de enviar, avança para"
      />
    </>
  );
}

// ============================================================
// receive_attachment
// ============================================================

const ATTACHMENT_TYPE_OPTIONS: Array<{
  value: "image" | "video" | "audio" | "document";
  label: string;
}> = [
  { value: "image", label: "Imagem" },
  { value: "video", label: "Vídeo" },
  { value: "audio", label: "Áudio" },
  { value: "document", label: "Documento" },
];

interface ReceiveAttachmentCfg {
  prompt_text?: string;
  var_name?: string;
  allowed_types?: Array<"image" | "video" | "audio" | "document">;
  next_node_key?: string;
}

function ReceiveAttachmentForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
}: {
  cfg: ReceiveAttachmentCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
}) {
  const allowed = cfg.allowed_types ?? [];
  const toggleType = (
    type: "image" | "video" | "audio" | "document",
    checked: boolean,
  ) => {
    onUpdateConfig({
      allowed_types: checked
        ? [...allowed, type]
        : allowed.filter((t) => t !== type),
    });
  };

  return (
    <>
      <TextRow
        label="Mensagem de solicitação (opcional)"
        value={cfg.prompt_text ?? ""}
        onChange={(v) => onUpdateConfig({ prompt_text: v })}
        rows={2}
      />
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">
          Nome da variável (guarda o link do arquivo)
        </label>
        <Input
          value={cfg.var_name ?? ""}
          onChange={(e) =>
            onUpdateConfig({
              var_name: e.target.value.replace(/[^a-zA-Z0-9_]/g, ""),
            })
          }
          placeholder="ex.: comprovante"
          className="bg-muted font-mono text-xs"
        />
      </div>
      <div>
        <label className="mb-2 block text-xs text-muted-foreground">
          Tipos aceitos (nenhum selecionado = qualquer tipo)
        </label>
        <div className="flex flex-wrap gap-3">
          {ATTACHMENT_TYPE_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className="flex items-center gap-1.5 text-xs text-foreground"
            >
              <Checkbox
                checked={allowed.includes(opt.value)}
                onCheckedChange={(checked) => toggleType(opt.value, checked === true)}
              />
              {opt.label}
            </label>
          ))}
        </div>
      </div>
      <NextNodeRow
        value={cfg.next_node_key ?? ""}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label="Depois de receber, avança para"
      />
    </>
  );
}

// ============================================================
// ai_agent
// ============================================================

interface AiAgentCfg {
  mode?: "once" | "loop" | "takeover";
  model?: string | null;
  system_prompt_override?: string;
  next_node_key?: string;
  max_turns?: number;
  tools?: AiAgentTool[];
  /** Ids de ferramentas do catálogo (wacrm.ai_tools). */
  tool_refs?: string[];
  /** Agente (perfil) de Configurações → Agentes. */
  agent_id?: string;
  failure_next_node_key?: string;
  herdar_contexto_anterior?: boolean;
}

const AI_AGENT_MODE_OPTIONS: Array<{
  value: NonNullable<AiAgentCfg["mode"]>;
  label: string;
}> = [
  { value: "once", label: "Responder uma vez" },
  { value: "loop", label: "Loop (responde cada mensagem)" },
  { value: "takeover", label: "Assumir conversa" },
];

function AiAgentForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
}: {
  cfg: AiAgentCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
}) {
  const mode = cfg.mode ?? "once";
  const { flow } = useFlowEditor();
  const [accountProvider, setAccountProvider] = useState<AiProvider | null>(null);
  const [providerLoading, setProviderLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch("/api/account/ai-config");
        const data = await res.json().catch(() => null);
        if (!cancelled && res.ok && data?.api_provider) {
          setAccountProvider(data.api_provider as AiProvider);
        }
      } catch (err) {
        console.error("[AiAgentForm] failed to load account provider:", err);
      } finally {
        if (!cancelled) setProviderLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const availableModels = getAiModelsForProvider(accountProvider);
  const modelValue = cfg.model?.trim() || "__account_default__";

  return (
    <>
      {/* ── Agente (perfil) — Fase 4 ── */}
      <AgentPicker
        agentId={cfg.agent_id}
        failureKey={cfg.failure_next_node_key}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(patch) => onUpdateConfig(patch)}
      />

      {/* Configuração inline = LEGADO. Com agente ela é ignorada (o agente define tudo). */}
      <details open={!cfg.agent_id} className="space-y-3">
        <summary className="cursor-pointer text-sm font-medium text-foreground">
          Configuração legada (sem agente)
          {cfg.agent_id ? " — ignorada enquanto houver agente" : ""}
        </summary>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">Modo</label>
        <Select
          value={mode}
          onValueChange={(v) =>
            onUpdateConfig({ mode: v as AiAgentCfg["mode"] })
          }
        >
          <SelectTrigger className="bg-muted">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AI_AGENT_MODE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="mt-1 text-[10px] text-muted-foreground">
          {mode === "once" &&
            "Chama o agente de IA uma vez para responder à última mensagem do cliente, depois avança."}
          {mode === "loop" &&
            "Chama o agente de IA a cada nova mensagem do cliente, sem sair deste nó, até o limite de turnos."}
          {mode === "takeover" &&
            "Chama o agente de IA uma última vez e encerra o fluxo, transferindo a conversa."}
        </p>
      </div>

      <div>
        <label className="mb-1 block text-xs text-muted-foreground">Modelo</label>
        <Select
          value={modelValue}
          disabled={providerLoading || !accountProvider}
          onValueChange={(value) =>
            onUpdateConfig({
              model: value === "__account_default__" ? null : value,
            })
          }
        >
          <SelectTrigger className="bg-muted">
            <SelectValue
              placeholder={
                providerLoading ? "Carregando modelos..." : "Usar padrão da conta"
              }
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__account_default__">Usar padrão da conta</SelectItem>
            {availableModels.map((model) => (
              <SelectItem key={model.id} value={model.id}>
                {model.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="mt-1 text-[10px] text-muted-foreground">
          {accountProvider
            ? `Provider da conta: ${aiProviderLabel(accountProvider)}. O nó só pode escolher modelos desse provider.`
            : providerLoading
              ? "Carregando o provider configurado na conta..."
              : "Configure primeiro o provider do Agente de IA nas configurações da conta."}
        </p>
      </div>

      <div className="-mb-2 flex justify-end">
        <PromptHistoryButton
          target={{ scope: "flow_node", flowId: flow.id, nodeKey: currentKey }}
          currentContent={cfg.system_prompt_override ?? ""}
          onRestore={(content) => onUpdateConfig({ system_prompt_override: content })}
          description="Versões publicadas das instruções deste nó, da mais recente para a mais antiga. Restaurar coloca o texto de volta no campo; ele só entra no ar depois de publicar o fluxo."
        />
      </div>
      <TextRow
        label="Instruções da IA para este nó (opcional, substituem as gerais)"
        value={cfg.system_prompt_override ?? ""}
        onChange={(v) => onUpdateConfig({ system_prompt_override: v })}
        rows={4}
      />
      <p className="-mt-2 text-[10px] text-muted-foreground">
        Deixe vazio para usar o prompt da configuração de IA
      </p>
      {!cfg.system_prompt_override?.trim() && (
        <p className="-mt-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[10px] text-amber-700 dark:text-amber-300">
          Sem instruções aqui, a IA usa o prompt da conta (Configurações → IA)
          e, nas contas DDM, também blocos fixos do sistema (Sabrina/Aleh) que
          não aparecem neste editor e só mudam com atualização do sistema.
        </p>
      )}

      {mode === "loop" && (
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            Limite de turnos (segurança)
          </label>
          <Input
            type="number"
            min={1}
            value={cfg.max_turns ?? 20}
            onChange={(e) => {
              const n = Number(e.target.value);
              onUpdateConfig({
                max_turns: Number.isFinite(n) && n > 0 ? Math.round(n) : 20,
              });
            }}
            className="bg-muted"
          />
          <p className="mt-1 text-[10px] text-muted-foreground">
            Após esse número de respostas neste nó, o fluxo avança
            automaticamente para o próximo nó.
          </p>
        </div>
      )}

      {(() => {
        // Sem system_prompt_override, a injeção de contexto (engine.ts:
        // runAiAgentCore) vira o prompt inteiro do nó, substituindo o
        // prompt padrão da conta — desabilita o switch até o autor
        // configurar um prompt próprio, em vez de deixar ativar uma
        // combinação que provavelmente não é o que ele quer.
        const promptOverrideVazio = !cfg.system_prompt_override?.trim();
        const herdarSwitch = (
          <Switch
            checked={cfg.herdar_contexto_anterior ?? false}
            disabled={promptOverrideVazio}
            onCheckedChange={(checked) =>
              onUpdateConfig({ herdar_contexto_anterior: checked })
            }
          />
        );
        return (
          <div className="flex items-center gap-2">
            {promptOverrideVazio ? (
              <Tooltip>
                <TooltipTrigger render={<span className="inline-flex" />}>
                  {herdarSwitch}
                </TooltipTrigger>
                <TooltipContent side="top">
                  Preencha as &quot;Instruções da IA para este nó&quot; acima para habilitar esta opção.
                </TooltipContent>
              </Tooltip>
            ) : (
              herdarSwitch
            )}
            <label className="text-xs text-muted-foreground">
              Herdar contexto do agente anterior
            </label>
          </div>
        );
      })()}
      <p className="-mt-2 text-[10px] text-muted-foreground">
        Injeta os resultados de ferramentas do nó de IA anterior nesta conversa.
        Requer que este nó tenha um prompt próprio configurado.
      </p>

      {mode !== "takeover" && (
        <NextNodeRow
          value={cfg.next_node_key ?? ""}
          allNodes={allNodes}
          currentKey={currentKey}
          onChange={(v) => onUpdateConfig({ next_node_key: v })}
          label={
            mode === "loop"
              ? "Ao atingir o limite de turnos, avança para"
              : "Depois de responder, avança para"
          }
        />
      )}

      {/* ── Ferramentas do catálogo (Configurações → Ferramentas) ── */}
      <ToolCatalogPicker
        selected={cfg.tool_refs ?? []}
        onChange={(refs) => onUpdateConfig({ tool_refs: refs })}
      />

      {/* ── Tools ── */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-foreground">
            Ferramentas inline (legado)
          </label>
          <button
            type="button"
            onClick={() => {
              const newTool: AiAgentTool = {
                name: "",
                description: "",
                parameters: { type: "object", properties: {}, required: [] },
                http: { url: "", method: "GET", headers: {}, body: "" },
              };
              onUpdateConfig({ tools: [...(cfg.tools ?? []), newTool] });
            }}
            className="text-xs text-primary hover:underline"
          >
            + Adicionar ferramenta
          </button>
        </div>

        {(cfg.tools ?? []).length === 0 && (
          <p className="text-xs text-muted-foreground">
            Nenhuma tool configurada. Tools permitem que o agente faça chamadas HTTP
            durante a conversa (ex: consultar CPF, buscar dados externos).
          </p>
        )}

        {(cfg.tools ?? []).map((tool, toolIdx) => (
          <div key={toolIdx} className="rounded-md border border-border bg-muted/30 p-3 space-y-3">
            {/* Tool header */}
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-foreground">
                Ferramenta {toolIdx + 1}{tool.name ? `: ${tool.name}` : ""}
              </span>
              <button
                type="button"
                onClick={() => {
                  const updated = (cfg.tools ?? []).filter((_, i) => i !== toolIdx);
                  onUpdateConfig({ tools: updated });
                }}
                className="text-xs text-destructive hover:underline"
              >
                Remover
              </button>
            </div>

            <AiToolEditor
              tool={tool}
              onChange={(next) =>
                onUpdateConfig({ tools: (cfg.tools ?? []).map((t, i) => (i === toolIdx ? next : t)) })
              }
            />
          </div>
        ))}
      </div>
      </details>
    </>
  );
}


/** Próximo id livre ("btn_3"): contar o tamanho repetia id depois de remover um botão. */
function nextFreeReplyId(prefix: string, existing: Array<string | undefined>): string {
  const taken = new Set(existing.filter(Boolean));
  let i = existing.length + 1;
  while (taken.has(`${prefix}_${i}`)) i += 1;
  return `${prefix}_${i}`;
}

/**
 * Formulário do nó: "Nome do nó" (opcional, só exibição — aparece no
 * diagrama e nas listas de "Próximo nó") + campos do tipo.
 */
export function NodeConfigForm(props: NodeConfigFormProps) {
  const label = (props.node.config as { label?: string }).label ?? "";
  return (
    <>
      <TextRow
        label="Nome do nó (opcional — ex.: Pergunta CPF)"
        value={label}
        onChange={(v) => props.onUpdateConfig({ label: v.slice(0, 60) })}
      />
      <NodeConfigFields {...props} />
    </>
  );
}

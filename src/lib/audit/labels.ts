// Rótulos da tela de auditoria (/relatorios/auditoria) para os valores
// gravados pelas triggers da migration 131 e por logAuditEvent. Puro —
// usado na tela, no modal e na exportação.

export interface AuditLog {
  id: string;
  account_id: string;
  event_type: "created" | "updated" | "deleted" | "action";
  resource_type: string;
  resource_id: string;
  resource_label: string | null;
  user_id: string | null;
  user_name: string | null;
  ip_address: string | null;
  user_agent: string | null;
  actor_type: string | null;
  source: string | null;
  action: string | null;
  summary: string | null;
  changes: Record<string, { before: unknown; after: unknown }> | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export const RESOURCE_LABEL: Record<string, string> = {
  contact: "Contato",
  conversation: "Conversa",
  campaign: "Campanha",
  flow: "Fluxo",
  automation: "Automação",
  whatsapp_line: "Linha WhatsApp",
  channel: "Canal",
  team: "Equipe",
  client: "Cliente",
  tag: "Etiqueta",
  template: "Template",
  member: "Membro",
  account: "Organização",
  invitation: "Convite",
  role: "Papel",
  access: "Acesso",
  audit: "Auditoria",
  api_key: "Chave de API",
};

export const EVENT_LABEL: Record<AuditLog["event_type"], string> = {
  created: "Criado",
  updated: "Atualizado",
  deleted: "Excluído",
  action: "Ação",
};

export const ACTOR_LABEL: Record<string, string> = {
  user: "Usuário",
  system: "Sistema",
  webhook: "Webhook",
  automation: "Automação",
  flow: "Fluxo",
  ai: "IA",
  api: "API",
};

export const ACTION_LABEL: Record<string, string> = {
  "contact.created": "Contato criado",
  "contact.updated": "Contato alterado",
  "contact.deleted": "Contato excluído",
  "contact.merged": "Contatos unidos",
  "contact.tag_added": "Etiqueta adicionada",
  "contact.tag_removed": "Etiqueta removida",
  "conversation.created": "Conversa iniciada",
  "conversation.deleted": "Conversa excluída",
  "conversation.assigned": "Conversa atribuída",
  "conversation.unassigned": "Atendente removido",
  "conversation.closed": "Conversa finalizada",
  "conversation.reopened": "Conversa reaberta",
  "conversation.status_changed": "Status alterado",
  "conversation.team_changed": "Equipe alterada",
  "conversation.updated": "Conversa alterada",
  "campaign.created": "Campanha criada",
  "campaign.updated": "Campanha alterada",
  "campaign.status_changed": "Status da campanha",
  "campaign.deleted": "Campanha excluída",
  "campaign.exported": "Exportação de campanha",
  "flow.created": "Fluxo criado",
  "flow.updated": "Fluxo alterado",
  "flow.status_changed": "Status do fluxo",
  "flow.deleted": "Fluxo excluído",
  "automation.created": "Automação criada",
  "automation.updated": "Automação alterada",
  "automation.toggled": "Automação ligada/desligada",
  "automation.deleted": "Automação excluída",
  "whatsapp_line.created": "Linha criada",
  "whatsapp_line.updated": "Linha alterada",
  "whatsapp_line.toggled": "Linha ligada/desligada",
  "whatsapp_line.deleted": "Linha excluída",
  "channel.created": "Canal conectado",
  "channel.updated": "Canal alterado",
  "channel.status_changed": "Status do canal",
  "channel.toggled": "Canal ligado/desligado",
  "channel.deleted": "Canal desconectado",
  "team.created": "Equipe criada",
  "team.updated": "Equipe alterada",
  "team.deleted": "Equipe excluída",
  "team.member_added": "Membro adicionado à equipe",
  "team.member_removed": "Membro removido da equipe",
  "member.created": "Membro criado",
  "member.updated": "Membro alterado",
  "member.deleted": "Membro removido",
  "member.role_changed": "Papel do membro alterado",
  "member.removed": "Membro saiu da organização",
  "member.joined": "Membro entrou na organização",
  "member.deactivated": "Membro desativado",
  "member.reactivated": "Membro reativado",
  "ownership.transferred": "Propriedade transferida",
  "account.renamed": "Organização renomeada",
  "invitation.created": "Convite criado",
  "invitation.revoked": "Convite revogado",
  "invitation.accepted": "Convite aceito",
  "role.created": "Papel criado",
  "role.updated": "Papel alterado",
  "role.deleted": "Papel excluído",
  "role.permissions_changed": "Permissões do papel alteradas",
  "access.denied": "Acesso negado",
  "audit.exported": "Exportação da auditoria",
  "conversation.batch_transferred_to_self": "Transferência em lote para si",
  "conversation.batch_closed": "Finalização em lote",
  "member.password_reset": "Senha do membro redefinida",
  "api_key.created": "Chave de API criada",
  "api_key.revoked": "Chave de API revogada",
};

/** Ações oferecidas no filtro (as mais usadas na investigação). */
export const ACTION_FILTER_OPTIONS = Object.entries(ACTION_LABEL).map(([value, label]) => ({ value, label }));

export const FIELD_LABEL: Record<string, string> = {
  name: "Nome",
  nome: "Nome",
  full_name: "Nome",
  phone: "Telefone",
  email: "E-mail",
  company: "Empresa",
  cpf: "CPF",
  status: "Status",
  assigned_agent_id: "Atendente",
  team_id: "Equipe",
  client_id: "Cliente",
  flow_id: "Fluxo",
  waha_session: "Sessão WAHA",
  outcome_tag_id: "Tabulação",
  account_role: "Papel",
  max_simultaneous_chats: "Máx. conversas simultâneas",
  is_active: "Ativa",
  habilitado: "Habilitado",
  trigger_type: "Gatilho",
  trigger_config: "Configuração do gatilho",
  line_ids: "Linhas",
  description: "Descrição",
  descricao: "Descrição",
  session_ids: "Números",
  tags_filtro: "Etiquetas (filtro)",
  agendamento: "Agendamento",
  janela_inicio: "Janela (início)",
  janela_fim: "Janela (fim)",
  intervalo_min: "Intervalo mín.",
  intervalo_max: "Intervalo máx.",
  batch_size: "Lote",
  webchat_enabled: "Webchat",
  entry_node_id: "Nó inicial",
  display_phone_number: "Número",
  phone_number_id: "Phone number ID",
  provider: "Provedor",
  username: "Usuário",
  type: "Tipo",
  color: "Cor",
  category: "Categoria",
  language: "Idioma",
  body_text: "Texto",
};

export function fieldLabel(field: string): string {
  return FIELD_LABEL[field] ?? field;
}

export function actionLabel(log: Pick<AuditLog, "action" | "event_type" | "resource_type">): string {
  if (log.action && ACTION_LABEL[log.action]) return ACTION_LABEL[log.action];
  const resource = RESOURCE_LABEL[log.resource_type] ?? log.resource_type;
  return `${resource} — ${EVENT_LABEL[log.event_type] ?? log.event_type}`;
}

/** Quem fez, em texto: nome do usuário ou o tipo de ator automático. */
export function actorLabel(log: Pick<AuditLog, "user_name" | "user_id" | "actor_type">): string {
  if (log.user_name) return log.user_name;
  if (log.user_id) return "Usuário removido";
  return ACTOR_LABEL[log.actor_type ?? ""] ?? "Sistema";
}

/** Valor antes/depois legível (texto, número, booleano ou JSON). */
export function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "(vazio)";
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

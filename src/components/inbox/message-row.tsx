"use client";

// Uma mensagem do histórico (bolha + ações). Memoizada: entrou uma mensagem
// nova ou chegou um evento da conversa? Só a linha que mudou renderiza de novo,
// em vez de todas as bolhas da tela. As funções vêm estáveis do histórico e os
// objetos pequenos (autor, citação, campanha) são comparados pelo conteúdo.

import { memo } from "react";
import type { Message, MessageReaction } from "@/types";
import { MessageActions } from "./message-actions";
import { MessageBubble } from "./message-bubble";

interface AuthorInfo {
  label: string;
  className: string;
  bot: boolean;
}
interface ReplyInfo {
  authorLabel: string;
  preview: string;
}
interface CampaignInfo {
  name: string;
  href: string | null;
}

export interface MessageRowProps {
  message: Message;
  author: AuthorInfo | null;
  reply: ReplyInfo | null;
  reactions: MessageReaction[] | undefined;
  campaign: CampaignInfo | null;
  currentUserId: string | undefined;
  /** Estáveis (não mudam entre renders do histórico). */
  onReply: (message: Message) => void;
  onReact: (messageId: string, emoji: string) => void;
}

const sameAuthor = (a: AuthorInfo | null, b: AuthorInfo | null) =>
  a === b || (!!a && !!b && a.label === b.label && a.className === b.className && a.bot === b.bot);
const sameReply = (a: ReplyInfo | null, b: ReplyInfo | null) =>
  a === b || (!!a && !!b && a.authorLabel === b.authorLabel && a.preview === b.preview);
const sameCampaign = (a: CampaignInfo | null, b: CampaignInfo | null) =>
  a === b || (!!a && !!b && a.name === b.name && a.href === b.href);

/** Igual = não precisa renderizar de novo. Exportado para teste. */
export function rowPropsEqual(a: MessageRowProps, b: MessageRowProps): boolean {
  return (
    a.message === b.message &&
    a.reactions === b.reactions &&
    a.currentUserId === b.currentUserId &&
    a.onReply === b.onReply &&
    a.onReact === b.onReact &&
    sameAuthor(a.author, b.author) &&
    sameReply(a.reply, b.reply) &&
    sameCampaign(a.campaign, b.campaign)
  );
}

export const MessageRow = memo(function MessageRow({
  message,
  author,
  reply,
  reactions,
  campaign,
  currentUserId,
  onReply,
  onReact,
}: MessageRowProps) {
  // Clicar numa reação que já é minha tira; em outra, troca (mesma regra de antes).
  const handlePillToggle = (emoji: string) => {
    const own = reactions?.find((r) => r.actor_type === "agent" && r.actor_id === currentUserId);
    onReact(message.id, own?.emoji === emoji ? "" : emoji);
  };
  return (
    <MessageActions
      message={message}
      onReply={() => onReply(message)}
      onReact={(emoji) => {
        if (emoji) onReact(message.id, emoji);
      }}
    >
      <MessageBubble
        message={message}
        reply={reply}
        reactions={reactions}
        currentUserId={currentUserId}
        onToggleReaction={handlePillToggle}
        campaign={campaign}
        author={author}
      />
    </MessageActions>
  );
}, rowPropsEqual);

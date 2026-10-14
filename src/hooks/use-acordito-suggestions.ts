"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  ACORDITO_MESSAGES,
  AcorditoError,
  fetchSuggestions,
  sendFeedback,
  type AcorditoErrorCode,
  type AcorditoSuggestion,
} from "@/lib/acordito/client";

export type AcorditoState =
  | { status: "idle" }
  | { status: "loading"; suggestions: AcorditoSuggestion[] }
  | { status: "ready"; suggestions: AcorditoSuggestion[] }
  | { status: "error"; code: AcorditoErrorCode; message: string };

/**
 * Sugestões do Acordito para a conversa aberta. Pede ao abrir a conversa e quando muda a última mensagem do
 * cliente (nunca a cada render: a chave conversa+mensagem evita repetir; o servidor ainda tem cache). O botão
 * "gerar de novo" manda force. Respostas antigas (de outra conversa/mensagem) são descartadas.
 * Feedback: used/edited ao enviar (reportSend) e ignored para as sugestões que ninguém usou.
 */
export function useAcorditoSuggestions({
  conversationId,
  lastCustomerMessageId,
  enabled,
}: {
  conversationId: string;
  lastCustomerMessageId: string | null;
  enabled: boolean;
}) {
  const [raw, setState] = useState<AcorditoState>({ status: "idle" });
  const seqRef = useRef(0);
  const keyRef = useRef<string | null>(null);
  const setRef = useRef<{ items: AcorditoSuggestion[]; pickedId: string | null; reported: boolean } | null>(null);
  const pickedTextRef = useRef<string | null>(null);

  const closeSet = useCallback(() => {
    const cur = setRef.current;
    if (cur && !cur.reported) {
      for (const s of cur.items) if (s.id !== cur.pickedId) sendFeedback(s.id, "ignored");
    }
    setRef.current = null;
    pickedTextRef.current = null;
  }, []);

  const load = useCallback(
    async (force: boolean) => {
      const seq = ++seqRef.current;
      closeSet();
      setState((prev) => ({ status: "loading", suggestions: prev.status === "ready" ? prev.suggestions : [] }));
      try {
        const res = await fetchSuggestions(conversationId, { force });
        if (seq !== seqRef.current) return;
        setRef.current = { items: res.suggestions, pickedId: null, reported: false };
        setState({ status: "ready", suggestions: res.suggestions });
      } catch (err) {
        if (seq !== seqRef.current) return;
        const e = err instanceof AcorditoError ? err : new AcorditoError("unknown", ACORDITO_MESSAGES.unknown);
        setState({ status: "error", code: e.code, message: e.message });
      }
    },
    [conversationId, closeSet],
  );

  useEffect(() => {
    if (!enabled) {
      keyRef.current = null;
      seqRef.current++;
      closeSet();
      return;
    }
    const key = `${conversationId}:${lastCustomerMessageId ?? ""}`;
    if (keyRef.current === key) return;
    keyRef.current = key;
    // Dispara a busca fora do corpo do efeito (o setState de "carregando" não roda síncrono aqui).
    queueMicrotask(() => {
      if (keyRef.current === key) void load(false);
    });
  }, [enabled, conversationId, lastCustomerMessageId, load, closeSet]);

  // Ao trocar de conversa ou desmontar: respostas pendentes são descartadas e o conjunto não usado vira "ignored".
  useEffect(
    () => () => {
      seqRef.current++;
      keyRef.current = null;
      closeSet();
    },
    [conversationId, closeSet],
  );

  /** O operador clicou numa sugestão: ela foi para o campo (o envio continua sendo dele). */
  const pick = useCallback((s: AcorditoSuggestion) => {
    if (setRef.current) setRef.current.pickedId = s.id;
    pickedTextRef.current = s.text;
  }, []);

  /** Chamar quando o operador envia: igual à sugestão = used; diferente = edited. */
  const reportSend = useCallback((sentText: string) => {
    const cur = setRef.current;
    const picked = pickedTextRef.current;
    if (!cur || !cur.pickedId || picked === null) return;
    sendFeedback(cur.pickedId, sentText.trim() === picked.trim() ? "used" : "edited");
    for (const s of cur.items) if (s.id !== cur.pickedId) sendFeedback(s.id, "ignored");
    cur.reported = true;
    pickedTextRef.current = null;
  }, []);

  const regenerate = useCallback(() => void load(true), [load]);

  const state: AcorditoState = enabled ? raw : { status: "idle" };
  return { state, pick, reportSend, regenerate };
}

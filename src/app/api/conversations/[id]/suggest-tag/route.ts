import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/flows/admin-client";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: conversationId } = await params;

    // Buscar últimas 20 mensagens da conversa
    const { data: messages } = await supabaseAdmin()
      .from("messages")
      .select("content_text, sender_type, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(20);

    if (!messages || messages.length === 0) {
      return NextResponse.json({ suggestion: null });
    }

    // Buscar tags de encerramento disponíveis
    const { data: tags } = await supabaseAdmin()
      .from("tags")
      .select("id, name")
      .eq("kind", "outcome")
      .order("name");

    if (!tags || tags.length === 0) {
      return NextResponse.json({ suggestion: null });
    }

    // Montar histórico cronológico
    const history = messages
      .reverse()
      .map(m => {
        const role = m.sender_type === "customer" ? "Cliente" : "Atendente";
        return `${role}: ${m.content_text || ""}`;
      })
      .join("\n");

    const tagNames = tags.map(t => t.name).join(", ");

    // Chamar OpenAI para sugestão
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      return NextResponse.json({ suggestion: null });
    }

    const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 150,
        messages: [
          {
            role: "system",
            content: `Você é um assistente de tabulação de atendimentos de cobrança educacional.
Analise a conversa e escolha a tag de encerramento mais adequada dentre as opções disponíveis.
Responda APENAS em JSON com este formato:
{"tag": "NOME_EXATO_DA_TAG", "motivo": "explicação em uma frase curta"}
Tags disponíveis: ${tagNames}`,
          },
          {
            role: "user",
            content: `Histórico da conversa:\n${history}`,
          },
        ],
      }),
    });

    if (!aiRes.ok) {
      return NextResponse.json({ suggestion: null });
    }

    const aiData = await aiRes.json();
    const content = aiData.choices?.[0]?.message?.content ?? "";

    let parsed: { tag: string; motivo: string } | null = null;
    try {
      const clean = content.replace(/```json|```/g, "").trim();
      parsed = JSON.parse(clean);
    } catch {
      return NextResponse.json({ suggestion: null });
    }

    if (!parsed) {
      return NextResponse.json({ suggestion: null });
    }

    // Encontrar a tag correspondente
    const matchedTag = tags.find(
      t => t.name.toLowerCase() === parsed?.tag?.toLowerCase()
    );

    if (!matchedTag) {
      return NextResponse.json({ suggestion: null });
    }

    return NextResponse.json({
      suggestion: {
        tag_id: matchedTag.id,
        tag_name: matchedTag.name,
        motivo: parsed.motivo,
      },
    });
  } catch (err: any) {
    console.error("[suggest-tag] error:", err);
    return NextResponse.json({ suggestion: null });
  }
}

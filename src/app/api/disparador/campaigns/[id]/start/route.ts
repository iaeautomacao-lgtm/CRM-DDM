import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { ensureQueueWorkerRunning } from "@/lib/disparador/worker";

// Use admin client to write to the queue bypassing RLS
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  { db: { schema: "wacrm" } }
);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createServerClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
    }

    ensureQueueWorkerRunning();
    const { id: campaignId } = await params;
    const now = new Date().toISOString();

    // 1. Fetch Campaign configuration
    const { data: campaign, error: campaignError } = await supabaseAdmin
      .from("campaigns")
      .select("*")
      .eq("id", campaignId)
      .single();

    if (campaignError || !campaign) {
      return NextResponse.json({ error: "Campanha não encontrada" }, { status: 404 });
    }

    // wacrm.campaigns has no account_id column (only created_by), so
    // ownership is checked per-user rather than per-account for now.
    if (campaign.created_by !== user.id) {
      return NextResponse.json(
        { error: "Você não tem permissão para executar esta campanha." },
        { status: 403 }
      );
    }

    const mensagens = Array.isArray(campaign.mensagens) ? campaign.mensagens : [];
    if (mensagens.length === 0) {
      return NextResponse.json(
        { error: "Campanha sem mensagens configuradas." },
        { status: 400 }
      );
    }

    const sessionIds = Array.isArray(campaign.session_ids) ? campaign.session_ids : [];
    if (sessionIds.length === 0) {
      return NextResponse.json(
        { error: "Campanha sem sessões de WhatsApp selecionadas." },
        { status: 400 }
      );
    }

    // 2. Remove previously scheduled/pending items to prevent duplication
    await supabaseAdmin
      .from("disp_message_queue")
      .delete()
      .eq("campaign_id", campaignId)
      .in("status", ["pendente", "agendado", "erro"]);

    // 3. Load active contacts
    const { data: allContacts, error: contactsError } = await supabaseAdmin
      .from("contacts")
      .select("id, name, phone");

    if (contactsError) {
      throw new Error(`Erro ao carregar contatos: ${contactsError.message}`);
    }

    if (!allContacts || allContacts.length === 0) {
      return NextResponse.json(
        { error: "Nenhum contato ativo encontrado no CRM." },
        { status: 400 }
      );
    }

    // Load contact tags relation
    const { data: tagsList } = await supabaseAdmin
      .from("contact_tags")
      .select("contact_id, tags:tag_id(name)");

    const tagsMap: Record<string, string[]> = {};
    if (tagsList) {
      for (const item of tagsList) {
        if (!item.contact_id) continue;
        const tagName = (item.tags as any)?.name;
        if (tagName) {
          if (!tagsMap[item.contact_id]) {
            tagsMap[item.contact_id] = [];
          }
          tagsMap[item.contact_id].push(tagName);
        }
      }
    }

    // Map tags to contacts in memory
    const contactsWithTags = allContacts.map((c) => ({
      ...c,
      tags: tagsMap[c.id] || [],
    }));

    // Filter contacts by tag
    const tagsFiltro = Array.isArray(campaign.tags_filtro) ? campaign.tags_filtro : [];
    const contacts = tagsFiltro.length > 0
      ? contactsWithTags.filter((c) => {
          const contactTags = Array.isArray(c.tags) ? c.tags : [];
          return tagsFiltro.some((t: string) => contactTags.includes(t));
        })
      : contactsWithTags;

    if (contacts.length === 0) {
      return NextResponse.json(
        { error: "Nenhum contato encontrado com as tags de filtro selecionadas." },
        { status: 400 }
      );
    }

    // Fetch Blacklist to skip
    const { data: blacklist } = await supabaseAdmin.from("blacklist").select("telefone");
    const blacklistSet = new Set((blacklist ?? []).map((b) => b.telefone));

    // 4. Scheduling queue generation loop
    const minDelay = (campaign.intervalo_min || 90) * 1000;
    const maxDelay = (campaign.intervalo_max || 300) * 1000;
    const intraDelay = 3000; // 3 seconds between messages for the same contact

    let contactDelay = 0;
    let enqueued = 0;
    const queueRows = [];

    for (let i = 0; i < contacts.length; i++) {
      const contact = contacts[i];

      // Skip if phone is blacklisted
      if (contact.phone && blacklistSet.has(contact.phone)) continue;

      // Select random session ID from campaign configurations
      const sessionId = sessionIds[Math.floor(Math.random() * sessionIds.length)];

      // Anti-spam pauses
      if (i > 0 && i % 100 === 0) contactDelay += 60 * 60 * 1000; // 1 hour pause every 100 contacts
      else if (i > 0 && i % 20 === 0) contactDelay += 10 * 60 * 1000; // 10 mins pause every 20 contacts

      for (let j = 0; j < mensagens.length; j++) {
        const msg = mensagens[j];
        const msgDelay = contactDelay + j * intraDelay;
        const scheduledAt = new Date(Date.now() + msgDelay).toISOString();

        // Interpolate message variables
        const rawText = msg.conteudo || msg.prompt || "";
        const interpolatedText = rawText.replace(/{nome}/g, contact.name || "Cliente");

        queueRows.push({
          campaign_id: campaignId,
          contact_id: contact.id,
          session_id: sessionId,
          mensagem_final: interpolatedText,
          status: "agendado",
          tipo: msg.tipo || "texto",
          media_url: msg.url || null,
          scheduled_at: scheduledAt,
        });
        enqueued++;
      }

      // Increment delay for the next contact
      contactDelay += (mensagens.length - 1) * intraDelay + minDelay + Math.random() * (maxDelay - minDelay);
    }

    if (queueRows.length > 0) {
      // Chunk insertions to prevent Supabase payload size limits (e.g. 500 items per chunk)
      const chunkSize = 500;
      for (let k = 0; k < queueRows.length; k += chunkSize) {
        const chunk = queueRows.slice(k, k + chunkSize);
        const { error: insertError } = await supabaseAdmin
          .from("disp_message_queue")
          .insert(chunk);
        if (insertError) throw insertError;
      }
    }

    // 5. Update campaign status to 'em_execucao' (In execution)
    await supabaseAdmin
      .from("campaigns")
      .update({ status: "em_execucao", agendamento: now })
      .eq("id", campaignId);

    // Update Metrics
    await supabaseAdmin
      .from("campaign_metrics")
      .upsert({
        campaign_id: campaignId,
        total_contatos: contacts.length,
      }, { onConflict: "campaign_id" });

    return NextResponse.json({ success: true, enqueued });
  } catch (err: any) {
    console.error("[Campaign Start] Failed to schedule queue:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

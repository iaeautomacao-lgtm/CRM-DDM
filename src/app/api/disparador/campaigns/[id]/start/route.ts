import { NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { ensureQueueWorkerRunning } from "@/lib/disparador/worker";

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

    // wacrm.campaigns has no account_id column yet (see migration 040,
    // not yet applied), so resolve the caller's account_id from their
    // profile to scope the contacts query below.
    const { data: profile } = await supabase
      .from("profiles")
      .select("account_id")
      .eq("user_id", user.id)
      .maybeSingle();

    const accountId = profile?.account_id;
    if (!accountId) {
      return NextResponse.json(
        { error: "Seu perfil não está vinculado a uma conta." },
        { status: 400 }
      );
    }

    ensureQueueWorkerRunning();
    const { id: campaignId } = await params;
    const now = new Date().toISOString();

    // 1. Fetch Campaign configuration
    const { data: campaign, error: campaignError } = await supabaseAdmin()
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

    // Only "rascunho" (never started) and "pausada" (resuming) are valid
    // starting points — the only 4 statuses this table ever uses are
    // rascunho/em_execucao/pausada/encerrada (see STATUS_LABELS in
    // campanhas/page.tsx). Enforced here, not just disabled in the UI,
    // so a direct call to this route can't re-run a campaign that's
    // already sending or restart one that's already closed.
    const STARTABLE_STATUSES = ["rascunho", "pausada"];
    if (!STARTABLE_STATUSES.includes(campaign.status)) {
      return NextResponse.json(
        {
          error:
            campaign.status === "em_execucao"
              ? "Esta campanha já está em execução."
              : "Esta campanha está encerrada e não pode ser reiniciada.",
        },
        { status: 409 }
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
    await supabaseAdmin()
      .from("disp_message_queue")
      .delete()
      .eq("campaign_id", campaignId)
      .in("status", ["pendente", "agendado", "erro"]);

    // 3. Load active contacts — scoped to the caller's account so a
    // campaign never sends to another account's contacts.
    const { data: allContacts, error: contactsError } = await supabaseAdmin()
      .from("contacts")
      .select("id, name, phone")
      .eq("account_id", accountId);

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
    const { data: tagsList } = await supabaseAdmin()
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
    const { data: blacklist } = await supabaseAdmin().from("blacklist").select("telefone");
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

        // Store the raw template text — {{variavel}} and legacy {nome}
        // placeholders are resolved at send time (worker.ts / cron/route.ts)
        // via applyTemplateVars, not here, so they reflect the contact's
        // current data and today's date rather than a snapshot from enqueue.
        const rawText = msg.conteudo || msg.prompt || "";

        queueRows.push({
          campaign_id: campaignId,
          contact_id: contact.id,
          session_id: sessionId,
          mensagem_final: rawText,
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
        const { error: insertError } = await supabaseAdmin()
          .from("disp_message_queue")
          .insert(chunk);
        if (insertError) throw insertError;
      }
    }

    // 5. Update campaign status to 'em_execucao' (In execution)
    await supabaseAdmin()
      .from("campaigns")
      .update({ status: "em_execucao", agendamento: now })
      .eq("id", campaignId);

    // Update Metrics
    await supabaseAdmin()
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

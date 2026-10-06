import { describe, expect, it } from "vitest";
import { createMemoryDb, type SimTables } from "./memory-db";

function setup(tables: SimTables = {}) {
  return { tables, db: createMemoryDb({ tables, clock: { last: 0 } }) };
}

describe("memory-db", () => {
  it("select com filtros, ordem, limite e maybeSingle", async () => {
    const { db } = setup({
      messages: [
        { id: "1", conversation_id: "c", sender_type: "customer", received_at: "2026-01-01T00:00:01Z" },
        { id: "2", conversation_id: "c", sender_type: "bot", received_at: "2026-01-01T00:00:02Z" },
        { id: "3", conversation_id: "c", sender_type: "customer", received_at: "2026-01-01T00:00:03Z" },
        { id: "4", conversation_id: "x", sender_type: "customer", received_at: "2026-01-01T00:00:04Z" },
      ],
    });
    const { data } = await db
      .from("messages")
      .select("id")
      .eq("conversation_id", "c")
      .eq("sender_type", "customer")
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    expect(data).toEqual({ id: "3" });

    const { data: after } = await db.from("messages").select("id").gt("received_at", "2026-01-01T00:00:01Z").in("conversation_id", ["c"]);
    expect(after).toEqual([{ id: "2" }, { id: "3" }]);
  });

  it("filter em caminho JSON e count/head", async () => {
    const { db } = setup({
      flow_run_events: [
        { id: "e1", event_type: "reply_received", payload: { meta_message_id: "m1" } },
        { id: "e2", event_type: "reply_received", payload: { meta_message_id: "m2" } },
      ],
    });
    const { count, data } = await db
      .from("flow_run_events")
      .select("id", { count: "exact", head: true })
      .eq("event_type", "reply_received")
      .filter("payload->>meta_message_id", "eq", "m2");
    expect(count).toBe(1);
    expect(data).toBeNull();
  });

  it("insert com select devolve a linha com id/created_at; update condicional", async () => {
    const { db, tables } = setup();
    const { data: run } = await db
      .from("flow_runs")
      .insert({ account_id: "a", contact_id: "k", status: "active", current_node_key: null })
      .select("*")
      .maybeSingle();
    expect(run).toMatchObject({ account_id: "a", status: "active" });
    expect(typeof (run as { id: string }).id).toBe("string");

    const { data: moved } = await db
      .from("flow_runs")
      .update({ current_node_key: "n1" })
      .eq("id", (run as { id: string }).id)
      .is("current_node_key", null)
      .select("id");
    expect(moved).toHaveLength(1);
    expect(tables.flow_runs[0].current_node_key).toBe("n1");

    const { data: lost } = await db.from("flow_runs").update({ current_node_key: "n2" }).is("current_node_key", null).select("id");
    expect(lost).toEqual([]);
  });

  it("índice de um run ativo por contato → 23505", async () => {
    const { db } = setup();
    await db.from("flow_runs").insert({ account_id: "a", contact_id: "k", status: "active" });
    const { error } = await db.from("flow_runs").insert({ account_id: "a", contact_id: "k", status: "active" }).select("*").maybeSingle();
    expect(error?.message).toContain("23505");
  });

  it("upsert por conflito e delete", async () => {
    const { db, tables } = setup();
    await db.from("contact_tags").upsert({ contact_id: "k", tag_id: "t" }, { onConflict: "contact_id,tag_id" });
    await db.from("contact_tags").upsert({ contact_id: "k", tag_id: "t" }, { onConflict: "contact_id,tag_id" });
    expect(tables.contact_tags).toHaveLength(1);
    await db.from("contact_tags").delete().eq("contact_id", "k").eq("tag_id", "t");
    expect(tables.contact_tags).toHaveLength(0);
  });

  it("rpc sem handler devolve erro (não lança)", async () => {
    const { db } = setup();
    const { error } = await db.rpc("qualquer");
    expect(error?.message).toContain("não simulada");
  });
});

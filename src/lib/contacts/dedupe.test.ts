import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  dedupeByPhone,
  findExistingContact,
  isExactMatch,
  isUniqueViolation,
  normalizeKey,
} from "./dedupe";

describe("normalizeKey", () => {
  it("strips every non-digit", () => {
    expect(normalizeKey("+1 (555) 123-4567")).toBe("15551234567");
    expect(normalizeKey("15551234567")).toBe("15551234567");
  });

  it("collapses different formats of the same number to one key", () => {
    expect(normalizeKey("+44 7911 123456")).toBe(normalizeKey("447911123456"));
  });
});

describe("isExactMatch", () => {
  it("treats different formatting of the same digits as exact", () => {
    expect(isExactMatch({ id: "1", phone: "+1 555-123-4567" }, "15551234567")).toBe(
      true,
    );
  });

  it("is false for a trunk-variant (fuzzy) match", () => {
    // last-8 match but not the same full number
    expect(isExactMatch({ id: "1", phone: "37063949836" }, "370063949836")).toBe(
      false,
    );
  });
});

describe("isUniqueViolation", () => {
  it("detects Postgres 23505", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
  });
  it("is false for other errors / non-objects", () => {
    expect(isUniqueViolation({ code: "23502" })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation("boom")).toBe(false);
  });
});

describe("dedupeByPhone", () => {
  it("keeps the first occurrence and counts in-file duplicates", () => {
    const { unique, duplicates } = dedupeByPhone([
      { phone: "+1 555-1111", name: "A" },
      { phone: "15551111", name: "B" }, // same digits as #1
      { phone: "+1 555-2222", name: "C" },
    ]);
    expect(unique.map((r) => r.name)).toEqual(["A", "C"]);
    expect(duplicates).toBe(1);
  });

  it("drops rows with no digits", () => {
    const { unique, duplicates } = dedupeByPhone([
      { phone: "   " },
      { phone: "+1 555-3333" },
    ]);
    expect(unique).toHaveLength(1);
    expect(duplicates).toBe(1);
  });
});

describe("findExistingContact", () => {
  // Minimal SupabaseClient stub, table-aware: `contacts` resolves the
  // .select().eq().like() chain (fuzzy suffix match, caminho primário);
  // `contact_phones` resolves .select().eq().limit().maybeSingle()
  // (fallback TELEFONE2/3) to a contact_id, which then round-trips
  // through a second `contacts` lookup by id (.select().eq().eq()
  // .maybeSingle()) to return the full contact row.
  function stubDb(
    contactsRows: Array<{ id: string; phone: string }>,
    altPhoneRows: Array<{ contact_id: string; phone_normalized: string }> = [],
  ): SupabaseClient {
    const from = (table: string) => {
      if (table === "contact_phones") {
        const builder = {
          select: () => builder,
          eq: (_col: string, val: string) => ({
            ...builder,
            limit: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: altPhoneRows.find((r) => r.phone_normalized === val) ?? null,
                  error: null,
                }),
            }),
          }),
        };
        return builder;
      }
      // contacts — dois formatos de chamada usados por findExistingContact:
      // 1) .select().eq('account_id',...).like(...)  -> caminho primário
      // 2) .select().eq('id',...).eq('account_id',...).maybeSingle() -> fallback
      const builder: any = {
        select: () => builder,
        like: () => Promise.resolve({ data: contactsRows, error: null }),
        eq: (col: string, val: string) => {
          if (col === "id") {
            const found = contactsRows.find((r) => r.id === val) ?? null;
            return {
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: found, error: null }),
              }),
            };
          }
          return builder;
        },
      };
      return builder;
    };
    return { from } as unknown as SupabaseClient;
  }

  it("returns a trunk-variant match via phonesMatch", async () => {
    const db = stubDb([{ id: "c1", phone: "37063949836" }]);
    const hit = await findExistingContact(db, "acct", "+370 063 949 836");
    expect(hit?.id).toBe("c1");
  });

  it("returns null when no candidate matches in contacts.phone or contact_phones", async () => {
    const db = stubDb([{ id: "c1", phone: "15559999999" }]);
    const hit = await findExistingContact(db, "acct", "+1 555-123-4567");
    expect(hit).toBeNull();
  });

  it("returns null for an empty phone without querying", async () => {
    const db = stubDb([{ id: "c1", phone: "15551234567" }]);
    expect(await findExistingContact(db, "acct", "   ")).toBeNull();
  });

  it("falls back to contact_phones (TELEFONE2/3) when contacts.phone has no match", async () => {
    const db = stubDb(
      [{ id: "c1", phone: "15551234567" }], // TELEFONE1 de c1 — número diferente
      [{ contact_id: "c1", phone_normalized: "15559998888" }], // TELEFONE2 de c1
    );
    const hit = await findExistingContact(db, "acct", "+1 555-999-8888");
    expect(hit?.id).toBe("c1");
  });

  it("does not touch contact_phones when contacts.phone already matched", async () => {
    // Se o fallback rodasse aqui, o stub de contact_phones não tem
    // linha nenhuma pra "15551234567" e devolveria null — o teste
    // falharia se o caminho primário não retornasse antes.
    const db = stubDb([{ id: "c1", phone: "15551234567" }], []);
    const hit = await findExistingContact(db, "acct", "15551234567");
    expect(hit?.id).toBe("c1");
  });
});

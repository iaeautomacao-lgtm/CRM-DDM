// Rotas /api/media/upload-url e /api/media/confirm: upload por URL assinada emitida pelo servidor + revalidação do objeto.
import { beforeEach, describe, expect, it, vi } from "vitest";

const ACC = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

const requirePermission = vi.fn();
vi.mock("@/lib/auth/account", () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  toErrorResponse: (e: unknown) => Response.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 500 }),
}));
const checkRateLimit = vi.fn(async () => ({ success: true }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...a: unknown[]) => (checkRateLimit as unknown as (...x: unknown[]) => unknown)(...a),
  rateLimitResponse: () => Response.json({ error: "rate" }, { status: 429 }),
}));

// Storage simulado: um objeto por caminho, com os metadados gravados e o conteúdo.
const objects = new Map<string, { size: number; mimetype: string; head: number[]; createdAt?: string }>();
const removed: string[] = [];
const createSignedUploadUrl = vi.fn(async (path: string) => ({ data: { path, token: "tok" }, error: null }));
vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({
    storage: {
      from: (bucket: string) => ({
        createSignedUploadUrl: (p: string) => createSignedUploadUrl(p),
        list: async (folder: string, opts: { search?: string }) => ({
          data: [...objects.entries()]
            .filter(([p]) => p.startsWith(`${folder}/`) && p.slice(folder.length + 1) === opts.search)
            .map(([p, o]) => ({ name: p.slice(folder.length + 1), created_at: o.createdAt ?? new Date().toISOString(), metadata: { size: o.size, mimetype: o.mimetype } })),
          error: null,
        }),
        createSignedUrl: async (p: string) => ({ data: { signedUrl: `https://storage.test/${bucket}/${p}` }, error: null }),
        remove: async (paths: string[]) => {
          removed.push(...paths);
          for (const p of paths) objects.delete(p);
          return { data: [], error: null };
        },
        getPublicUrl: (p: string) => ({ data: { publicUrl: `https://storage.test/public/${bucket}/${p}` } }),
      }),
    },
  }),
}));
vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string) => {
    const path = decodeURIComponent(String(url).replace(/^https:\/\/storage\.test\/[^/]+\//, ""));
    const o = objects.get(path);
    if (!o) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(o.head), { status: 206 });
  }),
);

const uploadUrl = await import("./upload-url/route");
const confirm = await import("./confirm/route");
const del = await import("./delete/route");

const post = (handler: (r: Request) => Promise<Response>, body: unknown) =>
  handler(new Request("https://x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(24).fill(0)];
const EXE_HEAD = [0x4d, 0x5a, 0x90, 0x00, ...new Array(28).fill(0)];

beforeEach(() => {
  requirePermission.mockReset();
  requirePermission.mockResolvedValue({ userId: "U1", accountId: ACC });
  checkRateLimit.mockClear();
  checkRateLimit.mockResolvedValue({ success: true });
  createSignedUploadUrl.mockClear();
  objects.clear();
  removed.length = 0;
});

describe("POST /api/media/upload-url", () => {
  it("emite URL assinada num caminho DENTRO da pasta da conta, com a permissão da origem", async () => {
    const res = await post(uploadUrl.POST, { purpose: "inbox", name: "Foto da loja.png", mime_type: "image/png", size: 1000 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bucket).toBe("chat-media");
    expect(body.path.startsWith(`account-${ACC}/`)).toBe(true);
    expect(body.path).toMatch(/foto_da_loja\.png$/i);
    expect(body.upload_token).toBe("tok");
    expect(requirePermission).toHaveBeenCalledWith("inbox.reply");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("a origem define bucket e permissão (fluxo → flow-media + flows.edit)", async () => {
    const res = await post(uploadUrl.POST, { purpose: "flow", name: "a.pdf", mime_type: "application/pdf", size: 10 });
    expect((await res.json()).bucket).toBe("flow-media");
    expect(requirePermission).toHaveBeenCalledWith("flows.edit");
    await post(uploadUrl.POST, { purpose: "template", name: "a.png", mime_type: "image/png", size: 10 });
    expect(requirePermission).toHaveBeenLastCalledWith("templates.manage");
    await post(uploadUrl.POST, { purpose: "campaign", name: "a.png", mime_type: "image/png", size: 10 });
    expect(requirePermission).toHaveBeenLastCalledWith("campaigns.manage");
    await post(uploadUrl.POST, { purpose: "internal_chat", name: "a.png", mime_type: "image/png", size: 10 });
    expect(requirePermission).toHaveBeenLastCalledWith("account.view");
  });

  it("sem a permissão da origem: nada é emitido", async () => {
    requirePermission.mockRejectedValue(Object.assign(new Error("sem permissão"), { status: 403 }));
    const res = await post(uploadUrl.POST, { purpose: "flow", name: "a.png", mime_type: "image/png", size: 10 });
    expect(res.status).toBe(403);
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("recusa origem desconhecida, tipo fora da lista e tamanho acima do teto do tipo", async () => {
    expect((await post(uploadUrl.POST, { purpose: "avatars", name: "a.png", mime_type: "image/png", size: 10 })).status).toBe(400);
    expect((await post(uploadUrl.POST, { name: "a.png", mime_type: "image/png", size: 10 })).status).toBe(400);
    expect((await post(uploadUrl.POST, { purpose: "inbox", name: "a.html", mime_type: "text/html", size: 10 })).status).toBe(400);
    expect((await post(uploadUrl.POST, { purpose: "inbox", name: "a.png", mime_type: "image/png", size: 6 * 1024 * 1024 })).status).toBe(400);
    expect((await post(uploadUrl.POST, { purpose: "inbox", name: "a.pdf", mime_type: "application/pdf", size: 0 })).status).toBe(400);
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("limite de uploads por minuto", async () => {
    checkRateLimit.mockResolvedValue({ success: false });
    const res = await post(uploadUrl.POST, { purpose: "inbox", name: "a.png", mime_type: "image/png", size: 10 });
    expect(res.status).toBe(429);
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("503 quando o Storage não gera a URL", async () => {
    createSignedUploadUrl.mockResolvedValueOnce({ data: null, error: { message: "x" } } as never);
    const res = await post(uploadUrl.POST, { purpose: "inbox", name: "a.png", mime_type: "image/png", size: 10 });
    expect(res.status).toBe(503);
  });
});

describe("POST /api/media/confirm", () => {
  const path = `account-${ACC}/abc-foto.png`;

  it("objeto íntegro: devolve a referência (chat-media → /api/chat-media/...)", async () => {
    objects.set(path, { size: 2000, mimetype: "image/png", head: PNG_HEAD });
    const res = await post(confirm.POST, { purpose: "inbox", path });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toBe(`/api/chat-media/${path}`);
    expect(body.kind).toBe("image");
    expect(removed).toEqual([]);
  });

  it("flow-media devolve a URL pública", async () => {
    objects.set(path, { size: 2000, mimetype: "image/png", head: PNG_HEAD });
    const res = await post(confirm.POST, { purpose: "flow", path });
    expect((await res.json()).url).toBe(`https://storage.test/public/flow-media/${path}`);
  });

  it("DISFARCE: executável gravado como image/png é recusado (422) e APAGADO", async () => {
    objects.set(path, { size: 2000, mimetype: "image/png", head: EXE_HEAD });
    const res = await post(confirm.POST, { purpose: "inbox", path });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("media_rejected");
    expect(removed).toEqual([path]);
  });

  it("tamanho acima do teto do tipo (a URL assinada não impõe): recusado e apagado", async () => {
    objects.set(path, { size: 6 * 1024 * 1024, mimetype: "image/png", head: PNG_HEAD });
    const res = await post(confirm.POST, { purpose: "inbox", path });
    expect(res.status).toBe(422);
    expect(removed).toEqual([path]);
  });

  it("MIME gravado fora da lista: recusado e apagado", async () => {
    objects.set(path, { size: 100, mimetype: "text/html", head: [0x3c, 0x68, 0x74, 0x6d, 0x6c] });
    const res = await post(confirm.POST, { purpose: "inbox", path });
    expect(res.status).toBe(422);
    expect(removed).toEqual([path]);
  });

  it("caminho de OUTRA conta ou com '..' vira 404, sem tocar no Storage", async () => {
    objects.set(`account-${OTHER}/x.png`, { size: 100, mimetype: "image/png", head: PNG_HEAD });
    for (const p of [`account-${OTHER}/x.png`, `account-${ACC}/../account-${OTHER}/x.png`, "meta/x.png", ""]) {
      const res = await post(confirm.POST, { purpose: "inbox", path: p });
      expect(res.status, p).toBe(404);
    }
    expect(removed).toEqual([]);
    expect(objects.has(`account-${OTHER}/x.png`)).toBe(true);
  });

  it("objeto inexistente: 404", async () => {
    const res = await post(confirm.POST, { purpose: "inbox", path });
    expect(res.status).toBe(404);
  });

  it("corpo inválido e permissão da origem", async () => {
    expect((await post(confirm.POST, { purpose: "inbox" })).status).toBe(400);
    expect((await post(confirm.POST, { purpose: "nada", path })).status).toBe(400);
    requirePermission.mockRejectedValue(Object.assign(new Error("sem permissão"), { status: 403 }));
    expect((await post(confirm.POST, { purpose: "flow", path })).status).toBe(403);
  });
});

describe("POST /api/media/delete (descarte de rascunho)", () => {
  const path = `account-${ACC}/abc-rascunho.png`;
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

  it("apaga anexo RECÉM-enviado da própria conta e pede a permissão da origem", async () => {
    objects.set(path, { size: 100, mimetype: "image/png", head: PNG_HEAD, createdAt: hoursAgo(0.1) });
    const res = await post(del.POST, { purpose: "inbox", path });
    expect(res.status).toBe(200);
    expect(removed).toEqual([path]);
    expect(requirePermission).toHaveBeenCalledWith("inbox.reply");
  });

  it("NÃO apaga mídia antiga (pode estar numa mensagem enviada): 409 e o objeto fica", async () => {
    objects.set(path, { size: 100, mimetype: "image/png", head: PNG_HEAD, createdAt: hoursAgo(5) });
    const res = await post(del.POST, { purpose: "inbox", path });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("not_staged");
    expect(removed).toEqual([]);
    expect(objects.has(path)).toBe(true);
  });

  it("outra conta, '..' e pasta fora da conta: 404 sem tocar no Storage", async () => {
    objects.set(`account-${OTHER}/x.png`, { size: 100, mimetype: "image/png", head: PNG_HEAD });
    for (const p of [`account-${OTHER}/x.png`, `account-${ACC}/../account-${OTHER}/x.png`, "meta/x.png", ""]) {
      expect((await post(del.POST, { purpose: "inbox", path: p })).status, p).toBe(404);
    }
    expect(removed).toEqual([]);
  });

  it("objeto inexistente: 404; corpo inválido: 400; sem permissão da origem: 403", async () => {
    expect((await post(del.POST, { purpose: "inbox", path })).status).toBe(404);
    expect((await post(del.POST, { purpose: "inbox" })).status).toBe(400);
    expect((await post(del.POST, { purpose: "avatars", path })).status).toBe(400);
    requirePermission.mockRejectedValue(Object.assign(new Error("sem permissão"), { status: 403 }));
    expect((await post(del.POST, { purpose: "flow", path })).status).toBe(403);
  });

  it("limite de descartes por minuto", async () => {
    checkRateLimit.mockResolvedValue({ success: false });
    expect((await post(del.POST, { purpose: "inbox", path })).status).toBe(429);
  });
});

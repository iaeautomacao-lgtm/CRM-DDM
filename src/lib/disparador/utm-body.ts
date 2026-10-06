const MAX_ALUNOS = 5000;

interface UtmBatchBody {
  canal: string;
  campanha: string;
  url_destino: string;
  alunos: string[];
}

/** Valida e reduz o corpo ao que o serviço de UTM aceita (nada além disso é repassado). */
export function parseUtmBatchBody(raw: unknown): UtmBatchBody | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  const canal = typeof b.canal === "string" ? b.canal.trim() : "";
  const campanha = typeof b.campanha === "string" ? b.campanha.trim() : "";
  const urlDestino = typeof b.url_destino === "string" ? b.url_destino.trim() : "";
  if (!canal || canal.length > 40 || !campanha || campanha.length > 200) return null;
  try {
    const u = new URL(urlDestino);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  } catch {
    return null;
  }
  if (
    !Array.isArray(b.alunos) ||
    b.alunos.length === 0 ||
    b.alunos.length > MAX_ALUNOS ||
    !b.alunos.every((a) => typeof a === "string" && a.length > 0 && a.length <= 40)
  ) {
    return null;
  }
  return { canal, campanha, url_destino: urlDestino, alunos: b.alunos as string[] };
}

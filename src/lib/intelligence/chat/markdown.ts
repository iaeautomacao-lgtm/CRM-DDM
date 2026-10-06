// Markdown mínimo das respostas do DDM Intelligence (o projeto não tem
// biblioteca de markdown): parágrafos, listas com "- "/"1. ", títulos
// "#", **negrito**, `código` e [links](url). Nada vira HTML cru — o
// componente monta elementos React a partir destes tokens.

export type InlineToken =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "code"; text: string }
  | { type: "link"; text: string; href: string; internal: boolean };

export type Block =
  | { type: "paragraph"; lines: InlineToken[][] }
  | { type: "heading"; tokens: InlineToken[] }
  | { type: "list"; ordered: boolean; items: InlineToken[][] };

const INLINE_RE = /\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;

/** Só caminhos internos ("/inbox?c=…") e http(s). Nada de javascript:, data:, //host. */
export function safeHref(href: string): { href: string; internal: boolean } | null {
  if (href.startsWith("/") && !href.startsWith("//")) return { href, internal: true };
  if (/^https?:\/\//i.test(href)) return { href, internal: false };
  return null;
}

export function parseInline(text: string): InlineToken[] {
  const out: InlineToken[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ type: "text", text: text.slice(last, idx) });
    if (m[1] !== undefined) {
      const safe = safeHref(m[2]);
      out.push(safe ? { type: "link", text: m[1], ...safe } : { type: "text", text: m[1] });
    } else if (m[3] !== undefined) {
      out.push({ type: "bold", text: m[3] });
    } else if (m[4] !== undefined) {
      out.push({ type: "code", text: m[4] });
    }
    last = idx + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}

const BULLET_RE = /^\s*[-*•]\s+(.*)$/;
const ORDERED_RE = /^\s*\d+[.)]\s+(.*)$/;
const HEADING_RE = /^\s*#{1,6}\s+(.*)$/;

export function parseMarkdown(src: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: InlineToken[][] | null = null;
  let list: Extract<Block, { type: "list" }> | null = null;

  const flush = () => {
    if (paragraph) blocks.push({ type: "paragraph", lines: paragraph });
    if (list) blocks.push(list);
    paragraph = null;
    list = null;
  };

  for (const line of src.replace(/\r\n/g, "\n").split("\n")) {
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: "heading", tokens: parseInline(heading[1]) });
      continue;
    }
    const bullet = BULLET_RE.exec(line);
    const ordered = bullet ? null : ORDERED_RE.exec(line);
    const item = bullet ?? ordered;
    if (item) {
      const isOrdered = !!ordered;
      if (!list || list.ordered !== isOrdered) {
        flush();
        list = { type: "list", ordered: isOrdered, items: [] };
      }
      list.items.push(parseInline(item[1]));
      continue;
    }
    if (list) flush();
    paragraph = paragraph ?? [];
    paragraph.push(parseInline(line));
  }
  flush();
  return blocks;
}

import { countIncomingReferences } from "@/lib/flows/edges";
import type { BuilderNode } from "./shared";

/**
 * Pede confirmação antes de excluir nós que recebem setas — excluir
 * desliga essas conexões em silêncio. Nó solto sai sem perguntar (e o
 * Desfazer traz de volta).
 */
export function confirmNodeRemoval(nodes: BuilderNode[], keys: string[]): boolean {
  const removing = new Set(keys);
  const remaining = nodes.filter((n) => !removing.has(n.node_key));
  const incoming = keys.reduce((sum, k) => sum + countIncomingReferences(remaining, k), 0);
  if (incoming === 0) return true;
  const what = keys.length === 1 ? `o nó "${keys[0]}"` : `${keys.length} nós`;
  return window.confirm(
    `Excluir ${what}? ${incoming} conexão(ões) que chegam nele(s) serão desligadas. Você pode desfazer com Ctrl+Z.`,
  );
}

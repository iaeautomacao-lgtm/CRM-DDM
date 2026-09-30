import { redirect } from "next/navigation";

// /disparador — campanhas é a tela principal agora (ver
// campanhas/page.tsx); o antigo conteúdo desta página ("Monitor da Fila
// em Tempo Real") virou secundário em /disparador/monitor, acessível via
// o botão "Monitor em tempo real" no header de campanhas. Redirect, não
// deletado, para que links/bookmarks antigos continuem resolvendo.
export default function DisparadorPage() {
  redirect("/disparador/campanhas");
}

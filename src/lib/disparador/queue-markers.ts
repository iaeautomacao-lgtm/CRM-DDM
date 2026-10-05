// Marcador usado em `template_name` para itens de fila de contatos
// externos (contact_id null) enviados via WAHA com texto livre. Contatos
// externos não têm uma linha em `contacts`, então mensagem_final (o único
// campo disponível quando contact_id é null) precisa guardar o telefone
// do destinatário — o texto já resolvido ({{1}}, {{2}}... substituídos)
// vai em template_variables[0] em vez de mensagem_final. Ver
// src/app/api/v1/disparador/campaigns/route.ts, que monta esses itens.
//
// Arquivo próprio (sem imports) para módulos puros poderem usar o
// marcador sem carregar processQueue.ts e suas dependências de I/O.
export const EXTERNAL_WAHA_TEXT_MARKER = "__external_waha_text__";

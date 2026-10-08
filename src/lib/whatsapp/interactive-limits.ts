// Limites de mensagens interativas da Meta (botões e listas). Fica num módulo
// PURO, sem dependência de servidor, porque o validador de fluxos
// (src/lib/flows/validate.ts) roda no navegador: importar meta-api.ts levava
// junto o undici (meta-dispatcher) e quebrava o editor de fluxos.
//   https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-reply-buttons-messages
//   https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-list-messages
export const INTERACTIVE_LIMITS = {
  maxButtons: 3,
  buttonTitleMaxLength: 20,
  maxListSections: 10,
  maxListRowsTotal: 10,
  listRowTitleMaxLength: 24,
  listRowDescriptionMaxLength: 72,
  bodyMaxLength: 1024,
  footerMaxLength: 60,
  headerTextMaxLength: 60,
} as const

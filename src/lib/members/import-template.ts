import { CSV_BOM } from "@/lib/security/csv-safe";

/** Modelo de CSV da importação de membros: BOM UTF-8 e `;` (abre com acentos no Excel pt-BR; a importação detecta o separador). */
export const MEMBER_IMPORT_TEMPLATE_CSV =
  CSV_BOM + "nome;email;role\r\nMaria Silva;maria.silva@empresa.com;operador\r\nJoão Souza;joao.souza@empresa.com;supervisor\r\n";

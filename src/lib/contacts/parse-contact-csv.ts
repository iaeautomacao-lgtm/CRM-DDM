/**
 * CSV parsing for the contacts import modal. Shared + unit-tested so
 * tag-column handling stays aligned with phone/name/email/company.
 */

export interface ParsedContactRow {
  phone: string;
  name?: string;
  email?: string;
  company?: string;
  /** Tag names from the optional `tags` column (comma/semicolon separated). */
  tagNames: string[];
}

/** Split a CSV cell into unique tag names (case-insensitive de-dupe). */
export function parseTagCell(value: string | undefined): string[] {
  if (!value?.trim()) return [];

  const seen = new Set<string>();
  const names: string[] = [];

  for (const part of value.split(/[,;]/)) {
    const name = part.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }

  return names;
}

export interface ParseContactCsvResult {
  rows: ParsedContactRow[];
  /** True when the CSV header includes a `tags` column. */
  hasTagsColumn: boolean;
  /** True when the CSV header includes a `company` column. */
  hasCompanyColumn: boolean;
}

/** 
 * Automatically clean and prefix phone numbers, especially for Brazil:
 * - If 10 or 11 digits (e.g. 21999999999), prepends 55 (Brazil).
 * - Always returns normalized E.164 with '+' prefix.
 */
export function smartNormalizePhone(phone: string): string {
  const alreadyHasCountryCode = phone.trim().startsWith('+');
  let cleaned = phone.replace(/\D/g, '');
  if (!cleaned) return '';

  if (cleaned.startsWith('00')) {
    cleaned = cleaned.slice(2);
  }

  // If it is 10 or 11 digits, and starts with a valid Brazilian DDD (11 to 99)
  // — but only when the original number had no explicit country code, since
  // an 11-digit number like +1 555 123 4567 would otherwise be misread as a
  // Brazilian DDD and get '55' prepended on top of its real country code.
  if (!alreadyHasCountryCode && (cleaned.length === 10 || cleaned.length === 11)) {
    const ddd = parseInt(cleaned.slice(0, 2), 10);
    if (ddd >= 11 && ddd <= 99) {
      cleaned = '55' + cleaned;
    }
  }

  return '+' + cleaned;
}

export function parseContactCsv(text: string): ParseContactCsvResult {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) {
    return { rows: [], hasTagsColumn: false, hasCompanyColumn: false };
  }

  // Auto-detect delimiter: comma vs semicolon (semicolon is very common in Excel exports in Brazil/Europe)
  const firstLine = lines[0];
  const commaCount = (firstLine.match(/,/g) || []).length;
  const semicolonCount = (firstLine.match(/;/g) || []).length;
  const delimiter = semicolonCount > commaCount ? ';' : ',';

  const headers = firstLine
    .split(delimiter)
    .map((h) => h.trim().toLowerCase().replace(/["']/g, ''));

  // Multi-language aliases to match columns gracefully
  const phoneAliases = ['phone', 'telefone', 'tel', 'celular', 'numero', 'número', 'whatsapp', 'whats', 'contato', 'contact'];
  const nameAliases = ['name', 'nome', 'fullname', 'nome completo', 'cliente'];
  const emailAliases = ['email', 'e-mail', 'mail', 'correio'];
  const companyAliases = ['company', 'company_name', 'empresa', 'razão social', 'corporação'];
  const tagsAliases = ['tags', 'tag', 'etiquetas', 'etiqueta', 'categoria', 'categorias', 'grupos', 'grupo'];

  const findHeaderIndex = (aliases: string[]) => {
    return headers.findIndex((h) => aliases.includes(h));
  };

  const phoneIdx = findHeaderIndex(phoneAliases);
  if (phoneIdx === -1) {
    return { rows: [], hasTagsColumn: false, hasCompanyColumn: false };
  }

  const nameIdx = findHeaderIndex(nameAliases);
  const emailIdx = findHeaderIndex(emailAliases);
  const companyIdx = findHeaderIndex(companyAliases);
  const tagsIdx = findHeaderIndex(tagsAliases);

  const rows: ParsedContactRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = parseCsvLine(line, delimiter);
    const rawPhone = values[phoneIdx]?.replace(/["']/g, '').trim();
    if (!rawPhone) continue;

    const phone = smartNormalizePhone(rawPhone);
    if (!phone || phone === '+') continue;

    rows.push({
      phone,
      name:
        nameIdx >= 0
          ? values[nameIdx]?.replace(/["']/g, '').trim() || undefined
          : undefined,
      email:
        emailIdx >= 0
          ? values[emailIdx]?.replace(/["']/g, '').trim() || undefined
          : undefined,
      company:
        companyIdx >= 0
          ? values[companyIdx]?.replace(/["']/g, '').trim() || undefined
          : undefined,
      tagNames:
        tagsIdx >= 0 ? parseTagCell(values[tagsIdx]?.replace(/["']/g, '')) : [],
    });
  }

  return {
    rows,
    hasTagsColumn: tagsIdx >= 0,
    hasCompanyColumn: companyIdx >= 0,
  };
}

/** Simple CSV line parse (handles quoted fields and dynamic delimiters). */
function parseCsvLine(line: string, delimiter: string = ','): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}

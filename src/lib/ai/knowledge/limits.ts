// Limites e tipos aceitos dos arquivos de conhecimento dos agentes (TASK1-B).
// MÓDULO PURO: sem I/O, pode ir ao navegador (a tela mostra os mesmos limites).

/** Teto do arquivo enviado (bytes). */
export const KB_MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Teto de páginas de um PDF (acima disso recusa antes de extrair). */
export const KB_MAX_PDF_PAGES = 300;
/** Tempo máximo de extração de PDF/DOCX (o worker é encerrado ao estourar). */
export const KB_EXTRACT_TIMEOUT_MS = 20_000;
/** Teto do texto extraído guardado por arquivo (caracteres). */
export const KB_MAX_TEXT_CHARS = 1_000_000;
/** Teto do nome do arquivo guardado. */
export const KB_MAX_NAME_CHARS = 200;

export type KnowledgeFileKind = 'pdf' | 'docx' | 'text';

/** Extensões aceitas (o tipo vale pela extensão; o MIME do navegador não é confiável). */
const BY_EXTENSION: Record<string, KnowledgeFileKind> = {
  pdf: 'pdf',
  docx: 'docx',
  txt: 'text',
  md: 'text',
  markdown: 'text',
  csv: 'text',
};

export const KB_ACCEPT = '.pdf,.docx,.txt,.md,.markdown,.csv';
export const KB_ACCEPT_LABEL = 'PDF, DOCX, TXT, MD ou CSV';

export function knowledgeFileKind(fileName: string): KnowledgeFileKind | null {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return null;
  return BY_EXTENSION[fileName.slice(dot + 1).toLowerCase()] ?? null;
}

const MIME_BY_KIND: Record<KnowledgeFileKind, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  text: 'text/plain',
};

/** MIME guardado: derivado da extensão (csv/md mantêm o próprio). */
export function knowledgeMimeType(fileName: string, kind: KnowledgeFileKind): string {
  const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'csv') return 'text/csv';
  if (ext === 'md' || ext === 'markdown') return 'text/markdown';
  return MIME_BY_KIND[kind];
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

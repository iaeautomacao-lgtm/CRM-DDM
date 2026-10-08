import { redirect } from 'next/navigation';

// A documentação da API agora é pública e vive em /docs/api (guia + referência).
export default function ApiDocsRedirect(): never {
  redirect('/docs/api');
}

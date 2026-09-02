import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface TemplateReorderEntry {
  id: string
  position: number
  folder_id: string | null
}

interface FolderReorderEntry {
  id: string
  position: number
}

interface ReorderBody {
  templates?: TemplateReorderEntry[]
  folders?: FolderReorderEntry[]
}

function isValidTemplateEntry(v: unknown): v is TemplateReorderEntry {
  if (!v || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  return (
    typeof e.id === 'string' &&
    UUID_RE.test(e.id) &&
    Number.isInteger(e.position) &&
    (e.folder_id === null || (typeof e.folder_id === 'string' && UUID_RE.test(e.folder_id)))
  )
}

function isValidFolderEntry(v: unknown): v is FolderReorderEntry {
  if (!v || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  return typeof e.id === 'string' && UUID_RE.test(e.id) && Number.isInteger(e.position)
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin')

    let body: ReorderBody
    try {
      body = (await request.json()) as ReorderBody
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
    }

    const templates = body.templates ?? []
    const folders = body.folders ?? []

    if (!Array.isArray(templates) || !templates.every(isValidTemplateEntry)) {
      return NextResponse.json({ error: 'Invalid templates payload.' }, { status: 400 })
    }
    if (!Array.isArray(folders) || !folders.every(isValidFolderEntry)) {
      return NextResponse.json({ error: 'Invalid folders payload.' }, { status: 400 })
    }
    if (templates.length === 0 && folders.length === 0) {
      return NextResponse.json({ error: 'Nothing to reorder.' }, { status: 400 })
    }

    // Verify every id (template, folder, and target folder_id) belongs
    // to the caller's account before writing anything — RLS would
    // scope the writes anyway, but a partial silent no-op on a
    // cross-account id is worse than a clear 403 up front.
    const templateIds = templates.map((t) => t.id)
    const folderIds = folders.map((f) => f.id)
    const targetFolderIds = [
      ...new Set(templates.map((t) => t.folder_id).filter((v): v is string => v !== null)),
    ]

    const [templateCheck, folderCheck, targetFolderCheck] = await Promise.all([
      templateIds.length
        ? supabase
            .from('message_templates')
            .select('id')
            .eq('account_id', accountId)
            .in('id', templateIds)
        : Promise.resolve({ data: [], error: null }),
      folderIds.length
        ? supabase
            .from('template_folders')
            .select('id')
            .eq('account_id', accountId)
            .in('id', folderIds)
        : Promise.resolve({ data: [], error: null }),
      targetFolderIds.length
        ? supabase
            .from('template_folders')
            .select('id')
            .eq('account_id', accountId)
            .in('id', targetFolderIds)
        : Promise.resolve({ data: [], error: null }),
    ])

    if (templateCheck.error || folderCheck.error || targetFolderCheck.error) {
      return NextResponse.json({ error: 'Failed to validate ownership.' }, { status: 500 })
    }
    if ((templateCheck.data?.length ?? 0) !== templateIds.length) {
      return NextResponse.json(
        { error: 'One or more templates do not belong to your account.' },
        { status: 403 },
      )
    }
    if ((folderCheck.data?.length ?? 0) !== folderIds.length) {
      return NextResponse.json(
        { error: 'One or more folders do not belong to your account.' },
        { status: 403 },
      )
    }
    if ((targetFolderCheck.data?.length ?? 0) !== targetFolderIds.length) {
      return NextResponse.json(
        { error: 'One or more target folders do not belong to your account.' },
        { status: 403 },
      )
    }

    // Plain per-row UPDATEs rather than a batched upsert: upsert
    // would require supplying every NOT NULL column (name, body_text,
    // …) on each row since Postgres validates the proposed insert
    // tuple before it discovers the conflict and falls back to
    // UPDATE. These rows already exist (checked above), so a
    // targeted UPDATE is both simpler and correct.
    const results = await Promise.all([
      ...templates.map((t) =>
        supabase
          .from('message_templates')
          .update({ position: t.position, folder_id: t.folder_id })
          .eq('id', t.id)
          .eq('account_id', accountId),
      ),
      ...folders.map((f) =>
        supabase
          .from('template_folders')
          .update({ position: f.position })
          .eq('id', f.id)
          .eq('account_id', accountId),
      ),
    ])

    const failed = results.filter((r) => r.error)
    if (failed.length > 0) {
      return NextResponse.json(
        { error: failed.map((f) => f.error?.message).join('; ') },
        { status: 500 },
      )
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

import { consoleObjectStore } from '@/lib/console/images'
import { supabaseServer } from '@/lib/supabase/server'
import { unauthorizedWorker, workerFailure } from '@/lib/match/worker-route'

export const runtime = 'nodejs'
export const maxDuration = 120

/**
 * The bytes behind a photograph, for the worker holding the live lease.
 * R2 credentials stay here (D111): the worker gets a stream, not a key.
 * D144: every photograph Loupe still identifies has an R2 source
 * (`source_storage_key`); a Drive-era row with none cannot be served.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const denied = unauthorizedWorker(request)
  if (denied) return denied
  try {
    const { jobId } = await context.params
    const token = new URL(request.url).searchParams.get('token') ?? ''
    const db = supabaseServer()
    const { data, error } = await db.rpc('match_job_source', { p_job: jobId, p_token: token })
    if (error) throw new Error(`match_job_source: ${error.message}`)
    const row = ((data ?? []) as { drive_file_id: string; mime_type: string | null; filename: string }[])[0]
    if (!row) return Response.json({ ok: false, error: 'No live lease for that job.' }, { status: 404 })
    const { data: file, error: fileError } = await db
      .from('intake_files')
      .select('source_storage_key')
      .eq('drive_file_id', row.drive_file_id)
      .maybeSingle<{ source_storage_key: string | null }>()
    if (fileError) throw new Error(`intake_files: ${fileError.message}`)
    if (!file?.source_storage_key) {
      return Response.json({ ok: false, error: 'No stored source for that job.' }, { status: 404 })
    }
    const bytes = await consoleObjectStore().get(file.source_storage_key)
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': row.mime_type ?? 'application/octet-stream',
        'Content-Length': String(bytes.byteLength),
        'Content-Disposition': `inline; filename="${row.filename.replace(/"/g, '')}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    return workerFailure(error)
  }
}

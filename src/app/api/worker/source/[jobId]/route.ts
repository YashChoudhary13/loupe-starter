import { googleDriveClient } from '@/lib/google/drive-server'
import { supabaseServer } from '@/lib/supabase/server'
import { unauthorizedWorker, workerFailure } from '@/lib/match/worker-route'

export const runtime = 'nodejs'
export const maxDuration = 120

/**
 * The bytes behind a Drive photograph, for the worker holding the live lease.
 * Drive credentials stay here (D111): the worker gets a stream, not a key.
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
    const { data, error } = await supabaseServer().rpc('match_job_source', { p_job: jobId, p_token: token })
    if (error) throw new Error(`match_job_source: ${error.message}`)
    const row = ((data ?? []) as { drive_file_id: string; mime_type: string | null; filename: string }[])[0]
    if (!row) return Response.json({ ok: false, error: 'No live lease for that job.' }, { status: 404 })
    const bytes = await googleDriveClient().downloadFile(row.drive_file_id)
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

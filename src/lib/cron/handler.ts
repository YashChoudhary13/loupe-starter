import { DriveError } from '@/lib/google/drive-errors'
import { IntakeRepositoryError } from '@/lib/intake/repository'

export interface CronPostOptions<T> {
  readonly expectedSecret: () => string
  readonly run: () => Promise<T>
}

function unauthorized(): Response {
  return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
}

function failure(error: unknown): Response {
  if (error instanceof DriveError) {
    return Response.json(
      {
        ok: false,
        error: error.message,
        retryable: error.retryable,
      },
      { status: error.retryable ? 503 : 502 },
    )
  }

  if (error instanceof IntakeRepositoryError) {
    return Response.json(
      {
        ok: false,
        error: error.message,
        retryable: error.retryable,
      },
      { status: error.retryable ? 503 : 500 },
    )
  }

  // Unknown/raw detail stays server-side. Route output remains readable and
  // cannot accidentally serialize a credential-bearing upstream exception.
  return Response.json(
    { ok: false, error: 'Cron job failed.', retryable: false },
    { status: 500 },
  )
}

export function createCronPostHandler<T>(
  options: CronPostOptions<T>,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    let expectedSecret: string
    try {
      expectedSecret = options.expectedSecret()
    } catch {
      return unauthorized()
    }

    const { isCronAuthorized } = await import('./auth')
    if (!isCronAuthorized(request, expectedSecret)) return unauthorized()

    try {
      const result = await options.run()
      return Response.json({ ok: true, ...result })
    } catch (error) {
      return failure(error)
    }
  }
}

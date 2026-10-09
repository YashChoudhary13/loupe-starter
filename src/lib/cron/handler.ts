export interface CronPostOptions<T> {
  readonly expectedSecret: () => string
  readonly run: () => Promise<T>
}

function unauthorized(): Response {
  return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
}

/**
 * Unknown/raw detail stays server-side. Route output remains readable and
 * cannot accidentally serialize a credential-bearing upstream exception.
 * (D144: the Drive and enhancement error classes that used to be mapped here
 * are gone with their jobs.)
 */
function failure(error: unknown): Response {
  console.error('cron job failed:', error instanceof Error ? error.message : String(error))
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

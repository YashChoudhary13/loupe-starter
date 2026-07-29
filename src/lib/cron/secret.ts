const SECURE_CRON_SECRET = /^[A-Fa-f0-9]{64}$/

/**
 * Loupe cron credentials are exactly 32 random bytes encoded as hex.
 *
 * A strict shape is intentional: runtime and provisioning cannot accidentally
 * accept a memorable password where a machine credential is required.
 */
export function validatedCronSecret(raw: string | undefined | null): string {
  const value = raw?.trim() ?? ''
  if (!SECURE_CRON_SECRET.test(value)) {
    throw new Error(
      'CRON_SECRET must be exactly 32 random bytes encoded as 64 hex characters. ' +
        'Generate one with: openssl rand -hex 32',
    )
  }
  return value
}

import type { QcCommand } from './types'

export function orderGid(value: string): string {
  const id = value.replace(/^gid:\/\/shopify\/Order\//, '')
  if (!/^[1-9]\d{0,22}$/.test(id)) throw new Error('Open a valid Shopify order from the QC list.')
  return `gid://shopify/Order/${id}`
}

export function parseQcCommand(value: unknown): QcCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid QC request.')
  const input = value as Record<string, unknown>
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  if (typeof input.requestId !== 'string' || !uuid.test(input.requestId)) throw new Error('Retry from the QC screen so the scan can be saved once.')
  if (!['scan', 'complete', 'reset', 'undo'].includes(String(input.action))) throw new Error('Unknown QC action.')
  const command: QcCommand = { action: input.action as QcCommand['action'], requestId: input.requestId }
  if (command.action === 'scan') {
    if (!Number.isSafeInteger(input.expectedGeneration) || Number(input.expectedGeneration) < 1) throw new Error('Refresh the current QC checklist before scanning.')
    command.expectedGeneration = Number(input.expectedGeneration)
    if (typeof input.code !== 'string' || !/^[\x21-\x7e]{1,64}$/.test(input.code.trim())) throw new Error('Scan a barcode or SKU of 1–64 characters. Spaces and control characters are not supported.')
    command.code = input.code.trim()
  } else {
    if (!Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion) < 0) throw new Error('Refresh this order before continuing.')
    command.expectedVersion = Number(input.expectedVersion)
  }
  if (command.action === 'undo') {
    if (typeof input.undoEventId !== 'string' || !uuid.test(input.undoEventId)) throw new Error('Choose a saved scan to undo.')
    command.undoEventId = input.undoEventId
  }
  if (command.action === 'reset' || command.action === 'undo') {
    if (typeof input.reason !== 'string' || input.reason.trim().length < 3 || input.reason.trim().length > 240) throw new Error('Enter a short reason (3–240 characters) for the audit history.')
    command.reason = input.reason.trim()
  }
  return command
}

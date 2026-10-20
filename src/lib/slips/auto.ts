/** Auto print (?auto on Print slips): the page re-reads the open orders every few minutes and prints whatever is new,
 * until the 4:30 PM IST dispatch cutoff. The office PC opens the page at logon in a kiosk-printing browser, so the
 * dialog never shows (owner, 2026-10-20). Pure helpers; the clock is read by the caller. */
export const AUTO_EVERY_MS = 3 * 60_000
export const CUTOFF_IST = 16 * 60 + 30

/** Minutes since midnight in Asia/Kolkata. */
export function istMinutes(now = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  const part = (type: string) => Number(parts.find(item => item.type === type)?.value ?? 0)
  return part('hour') * 60 + part('minute')
}
export const autoDue = (minutes: number): boolean => minutes < CUTOFF_IST
export const istClock = (now = new Date()): string => now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })

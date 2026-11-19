/**
 * Runs `work(key)` with at most `maxAtOnce` runs at a time in this process, and never two for one key at once: a call
 * for a key that is already running asks for one more run after it (which finds the work done if nothing changed)
 * instead of a second run beside it. Any number of calls during one run make one more run, not many.
 *
 * ponytail: in-process only; a restart forgets the waiting runs. For design labels the search project's own labeller
 * picks up any product left without labels. A shared queue (a table with leases) only if that stops being true.
 */
export function perKeyQueue(work: (key: string) => Promise<void>, maxAtOnce: number): (key: string) => Promise<void> {
  const again = new Map<string, boolean>()
  const waiting: (() => void)[] = []
  let active = 0

  async function inSlot(key: string) {
    while (active >= maxAtOnce) await new Promise<void>((resolve) => waiting.push(resolve))
    active += 1
    try { await work(key) } finally { active -= 1; waiting.shift()?.() }
  }

  return async (key) => {
    if (again.has(key)) { again.set(key, true); return }
    try {
      do { again.set(key, false); await inSlot(key) } while (again.get(key))
    } finally { again.delete(key) }
  }
}

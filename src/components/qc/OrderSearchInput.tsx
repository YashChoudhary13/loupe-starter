'use client'

import { useEffect, useRef } from 'react'

/** The order search on the list. A scanner gun types into whatever is focused, so stray keystrokes are pulled into this
 * field: a slip's barcode scanned anywhere on the list lands here and its Enter sends the search (D180). */
export function OrderSearchInput({ defaultValue }: { defaultValue: string }) {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const capture = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const editable = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
      if (!editable && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) { input.current?.focus({ preventScroll: true }); input.current?.select() }
    }
    window.addEventListener('keydown', capture)
    return () => window.removeEventListener('keydown', capture)
  }, [])
  return <input ref={input} name="q" defaultValue={defaultValue} placeholder="Qimati5019" maxLength={60} autoComplete="off" className="min-h-11 min-w-0 rounded-pill bg-white px-4 py-3 text-[16px] focus:outline-2 focus:outline-ink" />
}

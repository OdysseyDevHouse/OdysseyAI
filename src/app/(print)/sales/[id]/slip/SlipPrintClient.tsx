'use client'

import { useEffect, useRef } from 'react'
import { Button, ButtonLink, Icons } from '@/components/ui'
import { recordPrintAction } from '@/app/(app)/sales/actions'

/**
 * The toolbar above the slip. `print-hidden` so the paper carries the slip
 * and nothing else.
 *
 * Printing the TAX slip counts it (recordPrint drives the COPY banner on the
 * next one); a GIFT slip does not — print_count marks copies of the tax
 * document, and a gift slip is not one.
 */
export default function SlipPrintClient({
  documentId,
  gift,
  auto,
}: {
  documentId: number
  gift: boolean
  auto: boolean
}) {
  const printed = useRef(false)

  function printNow() {
    if (!gift) void recordPrintAction(documentId).catch(() => {})
    window.print()
  }

  /* ?auto=1 — the till's Print button opened this tab to print, not to read. */
  useEffect(() => {
    if (!auto || printed.current) return
    printed.current = true
    // A beat for fonts/layout — printing a half-painted slip cuts it off.
    const timer = setTimeout(printNow, 150)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto])

  return (
    <div className="print-hidden mx-auto mb-3 flex w-full max-w-[72mm] items-center justify-between gap-2">
      <ButtonLink
        href={gift ? `/sales/${documentId}/slip` : `/sales/${documentId}/slip?gift=1`}
        variant="secondary"
        size="sm"
      >
        {gift ? 'Tax invoice' : 'Gift receipt'}
      </ButtonLink>
      <Button variant="primary" size="sm" onClick={printNow}>
        <Icons.Printer size={14} />
        Print
      </Button>
    </div>
  )
}

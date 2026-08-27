'use client'

import { useEffect, useRef } from 'react'
import { ButtonLink, Button, Icons } from '@/components/ui'

/**
 * The toolbar above the order.
 *
 * `print-hidden` (the (print) group's class) keeps it off the paper — the
 * supplier gets the document, not the buttons that produced it.
 *
 * Does NOT fire window.print() on mount by default: opened bare, this page is
 * something to READ, and a print dialog over paper nobody has looked at is how
 * the wrong thing gets printed.
 *
 * `auto` is the exception, for a caller that has already said "print" — the
 * hidden frame usePrintDocument renders into passes it, and there the dialog
 * IS the point. Same flag, same 150ms beat, and the same claim-on-print guard
 * as the sales document route: claiming it before the timeout runs means
 * Strict Mode's teardown clears the timer and the re-run bails, so nothing
 * ever prints.
 */
export default function OrderPrintButton({
  documentId,
  auto = false,
}: {
  documentId: number
  auto?: boolean
}) {
  const printed = useRef(false)

  useEffect(() => {
    if (!auto || printed.current) return
    // A beat for fonts/layout — printing a half-painted page splits it.
    const timer = setTimeout(() => {
      printed.current = true
      window.print()
    }, 150)
    return () => clearTimeout(timer)
  }, [auto])

  return (
    <div className="print-hidden mx-auto mb-4 flex w-full max-w-[52rem] items-center justify-between gap-2">
      <ButtonLink href={`/purchasing/${documentId}`} variant="secondary">
        <Icons.ChevronLeft size={15} />
        Back to the order
      </ButtonLink>
      <Button variant="primary" onClick={() => window.print()}>
        <Icons.Printer size={15} />
        Print
      </Button>
    </div>
  )
}

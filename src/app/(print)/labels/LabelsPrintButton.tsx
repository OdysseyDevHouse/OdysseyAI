'use client'

import { useEffect, useRef } from 'react'
import { Button, Icons } from '@/components/ui'

/**
 * The toolbar above a label run. `print-hidden` keeps it off the paper.
 *
 * `auto` prints on arrival, for a caller that has already said "print" — the
 * hidden frame usePrintDocument renders into passes it. Opened bare the page
 * stays quiet, because a label sheet is often opened to count what is on it
 * before committing a sheet of stock to the printer.
 *
 * The guard is claimed inside the timeout rather than before it: claiming it
 * first means Strict Mode's teardown clears the timer and the re-run bails on
 * a ref that is already true, so nothing ever prints.
 */
export default function LabelsPrintButton({
  count,
  auto = false,
}: {
  count: number
  auto?: boolean
}) {
  const printed = useRef(false)

  useEffect(() => {
    if (!auto || printed.current) return
    // A beat for fonts/layout — a half-painted sheet prints short.
    const timer = setTimeout(() => {
      printed.current = true
      window.print()
    }, 150)
    return () => clearTimeout(timer)
  }, [auto])

  return (
    <div className="print-hidden mb-4 flex items-center justify-between gap-2 px-2">
      <span className="text-sm text-muted">
        {count} label{count === 1 ? '' : 's'}
      </span>
      <Button variant="primary" size="sm" onClick={() => window.print()}>
        <Icons.Printer size={14} />
        Print
      </Button>
    </div>
  )
}

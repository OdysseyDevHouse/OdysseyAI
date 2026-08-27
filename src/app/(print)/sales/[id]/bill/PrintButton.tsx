'use client'

import { useEffect, useRef } from 'react'
import { Button, Icons } from '@/components/ui'

/**
 * The toolbar above the bill.
 *
 * `print-hidden` — the (print) group's class — so the paper carries the bill
 * and nothing else. It used to say `print:hidden` while the route lived under
 * (app), which hid this toolbar and nothing else: the sidebar and top bar have
 * no print rules of their own, so the whole back office went on the paper
 * around the slip. Moving the route into the bare group fixed that; this class
 * is the group's own, and the one its stylesheet actually defines.
 *
 * `auto` prints on arrival, for the till's Print — the hidden frame
 * usePrintDocument renders into passes it, and there the dialog IS the point.
 * The guard is claimed inside the timeout, not before it: claiming it first
 * means Strict Mode's teardown clears the timer and the re-run bails on a ref
 * that is already true, so nothing ever prints.
 */
export default function PrintButton({ auto = false }: { auto?: boolean }) {
  const printed = useRef(false)

  useEffect(() => {
    if (!auto || printed.current) return
    // A beat for fonts/layout — printing a half-painted slip cuts it off.
    const timer = setTimeout(() => {
      printed.current = true
      window.print()
    }, 150)
    return () => clearTimeout(timer)
  }, [auto])

  return (
    <div className="print-hidden mb-4 flex items-center justify-end">
      <Button variant="primary" onClick={() => window.print()}>
        <Icons.Printer size={15} />
        Print the bill
      </Button>
    </div>
  )
}

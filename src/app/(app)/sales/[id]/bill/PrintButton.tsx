'use client'

import { Button, Icons } from '@/components/ui'

/**
 * The toolbar above the bill.
 *
 * `print:hidden` so the paper carries the bill and nothing else. No back link:
 * this page opens in its own tab from the till, and closing it is the way back.
 */
export default function PrintButton() {
  return (
    <div className="mb-4 flex items-center justify-end print:hidden">
      <Button variant="primary" onClick={() => window.print()}>
        <Icons.Printer size={15} />
        Print the bill
      </Button>
    </div>
  )
}

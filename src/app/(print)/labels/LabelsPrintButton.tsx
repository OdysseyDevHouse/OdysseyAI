'use client'

import { Button, Icons } from '@/components/ui'

/** The toolbar above a label run. `print-hidden` keeps it off the paper. */
export default function LabelsPrintButton({ count }: { count: number }) {
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

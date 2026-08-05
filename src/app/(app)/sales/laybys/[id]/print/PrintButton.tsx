'use client'

import { ButtonLink, Button, Icons } from '@/components/ui'

/**
 * The toolbar above the agreement.
 *
 * Marked `print:hidden` so it does not appear on the paper — the customer gets
 * the document, not the buttons that produced it.
 */
export default function PrintButton({ laybyId }: { laybyId: number }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-2 print:hidden">
      <ButtonLink href={`/sales/laybys/${laybyId}`} variant="secondary">
        <Icons.ChevronLeft size={15} />
        Back to the lay-by
      </ButtonLink>
      <Button variant="primary" onClick={() => window.print()}>
        <Icons.Printer size={15} />
        Print two copies
      </Button>
    </div>
  )
}

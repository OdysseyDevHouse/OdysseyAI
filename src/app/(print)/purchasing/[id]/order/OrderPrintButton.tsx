'use client'

import { ButtonLink, Button, Icons } from '@/components/ui'

/**
 * The toolbar above the order.
 *
 * `print-hidden` (the (print) group's class) keeps it off the paper — the
 * supplier gets the document, not the buttons that produced it.
 *
 * Deliberately does NOT fire window.print() on mount. This page is opened in
 * its own tab from the order screen, and a dialog that appears before the
 * paper has been looked at is how the wrong thing gets printed; the reprint is
 * usually opened to check something first.
 */
export default function OrderPrintButton({ documentId }: { documentId: number }) {
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

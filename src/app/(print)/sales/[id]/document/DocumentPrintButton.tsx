'use client'

import { ButtonLink, Button, Icons } from '@/components/ui'
import type { SalesDocType } from '@/lib/site/salesDocuments'

/**
 * The toolbar above the document.
 *
 * `print-hidden` (the (print) group's class) keeps it off the paper — the
 * customer gets the document, not the buttons that produced it.
 *
 * Deliberately does NOT fire window.print() on mount. This page opens in its
 * own tab from the editor, and a dialog that appears before the paper has been
 * looked at is how the wrong thing gets printed — a pro forma is usually
 * opened to CHECK it before it goes anywhere.
 *
 * Back goes to the screen this document belongs to, not to a generic list: an
 * "invoicing" link on a quote is the same wrong turn the editor's own back
 * arrow used to make.
 */
export default function DocumentPrintButton({
  doc,
}: {
  doc: { id: number; docType: SalesDocType }
}) {
  const backHref =
    doc.docType === 'quote'
      ? `/invoicing/quotes/${doc.id}`
      : doc.docType === 'sales_order'
        ? `/invoicing/orders/${doc.id}`
        : `/invoicing/${doc.id}`

  const backLabel =
    doc.docType === 'quote'
      ? 'Back to the quote'
      : doc.docType === 'sales_order'
        ? 'Back to the order'
        : 'Back to the invoice'

  return (
    <div className="print-hidden mx-auto mb-4 flex w-full max-w-[52rem] items-center justify-between gap-2">
      <ButtonLink href={backHref} variant="secondary">
        <Icons.ChevronLeft size={15} />
        {backLabel}
      </ButtonLink>
      <Button variant="primary" onClick={() => window.print()}>
        <Icons.Printer size={15} />
        Print
      </Button>
    </div>
  )
}

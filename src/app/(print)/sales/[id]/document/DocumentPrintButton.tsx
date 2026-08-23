'use client'

import { useEffect, useRef } from 'react'
import { ButtonLink, Button, Icons } from '@/components/ui'
import type { SalesDocType } from '@/lib/site/salesDocuments'

/**
 * The toolbar above the document.
 *
 * `print-hidden` (the (print) group's class) keeps it off the paper — the
 * customer gets the document, not the buttons that produced it.
 *
 * Does NOT fire window.print() on mount by default. This page opens in its own
 * tab from the editor, and a dialog that appears before the paper has been
 * looked at is how the wrong thing gets printed — a pro forma is usually opened
 * to CHECK it before it goes anywhere.
 *
 * `auto` is the exception, and only the trade counter passes it: there the sale
 * has already posted and the customer is waiting for the page, so the dialog IS
 * the point. Same flag, same 150ms beat and same once-only ref as the slip
 * route's client — an A4 page has more to lay out than a slip, not less.
 *
 * Back goes to the screen this document belongs to, not to a generic list: an
 * "invoicing" link on a quote is the same wrong turn the editor's own back
 * arrow used to make.
 */
export default function DocumentPrintButton({
  doc,
  auto = false,
}: {
  doc: { id: number; docType: SalesDocType }
  auto?: boolean
}) {
  const printed = useRef(false)

  useEffect(() => {
    if (!auto || printed.current) return
    printed.current = true
    // A beat for fonts/layout — printing a half-painted page splits it.
    const timer = setTimeout(() => window.print(), 150)
    return () => clearTimeout(timer)
  }, [auto])

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

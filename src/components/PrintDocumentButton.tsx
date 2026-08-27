'use client'

import { Button, Icons, usePrintDocument } from '@/components/ui'

/**
 * A Print button on a SERVER-rendered screen.
 *
 * `usePrintDocument` is a hook, so a server page cannot call it — and most of
 * the screens that offer a print are server components (the purchase order,
 * the GRV's shelf labels). Rather than turn a whole page into a client
 * component to get one button, the button itself is the client boundary.
 *
 * It replaces what used to be a `<ButtonLink target="_blank">` at these call
 * sites: the label already said Print, so a tab of rendered document on the
 * way to the print dialog was a page nobody asked to read.
 */
export function PrintDocumentButton({
  href,
  label,
  variant = 'secondary',
  size,
}: {
  /** A route in the (print) group, without `auto` — the hook adds it. */
  href: string
  label: string
  variant?: 'primary' | 'secondary' | 'ghost'
  size?: 'md' | 'sm'
}) {
  const printDocument = usePrintDocument()

  return (
    <Button variant={variant} size={size} onClick={() => printDocument(href)}>
      <Icons.Printer size={15} />
      {label}
    </Button>
  )
}

'use client'

import { useEffect, useState } from 'react'
import {
  Modal,
  Button,
  Field,
  Input,
  Badge,
  Icons,
  TouchRow,
  CategoryTile,
  EmptyState,
  Skeleton,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { listPastSalesAction, type PastSaleRow } from './actions'

/**
 * Past sales, to print one again.
 *
 * ── WHY THIS DOES NOT NAVIGATE TO THE BACK OFFICE ─────────────────────────
 *
 * The reprint key used to push the browser to the invoice register. That takes the
 * till off the screen it exists to be — with a basket possibly half-scanned
 * behind it — and lands a cashier in a dense back-office list with filters,
 * pagination and columns about margin. Everything they needed was "find the sale,
 * press print".
 *
 * ── WHY IT OPENS ON RECENT SALES ──────────────────────────────────────────
 *
 * Nearly every reprint is for the sale that just happened: the printer jammed,
 * the customer wants a second copy, the slip tore. So the list opens on the most
 * recent invoices and needs no typing at all for that case. Searching is there
 * for the customer who comes back on Thursday holding a card statement, and it
 * matches the three things such a person can actually tell you — the invoice
 * number, their name, or the reference.
 *
 * ── COPY, NOT ORIGINAL ────────────────────────────────────────────────────
 *
 * Every row shows its print count, and the slip route stamps COPY through it. A
 * reprint that looked identical to the original would be a second document for
 * the same sale, which is exactly what a duplicate-invoice control exists to
 * prevent. The badge is there so the cashier knows before they hand it over.
 */
export function ReprintModal({
  open,
  onClose,
  onPrint,
}: {
  open: boolean
  onClose: () => void
  /** Prints one. The shell owns the bridge-or-browser decision. */
  onPrint: (sale: PastSaleRow) => void
}) {
  const [query, setQuery] = useState('')
  const [sales, setSales] = useState<PastSaleRow[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setQuery('')
  }, [open])

  /*
   * Runs with an EMPTY term too, unlike the customer searches on this screen.
   *
   * That is the difference between a picker and a list: a customer search has
   * nothing useful to show until somebody types, while "the last forty sales" is
   * the answer most of the time. Still debounced, because it also re-runs on
   * every keystroke once somebody does start typing.
   */
  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => {
      setLoading(true)
      listPastSalesAction(query)
        .then(setSales)
        .catch(() => setSales([]))
        .finally(() => setLoading(false))
    }, 180)
    return () => clearTimeout(timer)
  }, [open, query])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Reprint a slip"
      description="Finalised sales, newest first. Every reprint prints as a copy."
      size="lg"
      /* The body grows and the RESULTS LIST scrolls inside it. On a till the
         search box above must stay put while the rows scroll past — with the
         default cap the whole body scrolled as one and took the field the
         cashier was typing into with it. */
      bodyPins
      footer={
        <Button variant="secondary" size="touch" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="flex min-h-0 flex-col gap-3">
        <Field label="Find a sale">
          <Input
            size="touch"
            icon={<Icons.Search size={18} />}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Invoice number, customer or reference"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        {loading && sales.length === 0 && (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-touch w-full rounded-card" />
            ))}
          </div>
        )}

        {!loading && sales.length === 0 && (
          <EmptyState
            icon={<Icons.Printer size={26} />}
            title={query.trim() ? 'Nothing matches that' : 'No sales yet'}
            hint={
              query.trim()
                ? 'Try the invoice number, or the name on the account.'
                : 'Finalised sales show up here as soon as the shop starts trading.'
            }
          />
        )}

        {sales.length > 0 && (
          <div className="till-pane flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
            {sales.map((sale) => (
              <TouchRow
                key={sale.id}
                icon={<CategoryTile icon={<Icons.Printer size={20} />} tone="sky" size="lg" />}
                title={sale.documentNumber ?? `Sale ${sale.id}`}
                /* Date and who it was for — the two things somebody looking for
                   their own slip in a list of forty can actually match against. */
                subtitle={`${formatDate(sale.date)} · ${sale.customerName?.trim() || 'Walk-in'}`}
                trailing={
                  <span className="flex items-center gap-2">
                    {sale.printCount > 0 && <Badge tone="warning">Printed</Badge>}
                    <span className="numeric text-base font-medium text-ink">
                      {formatMoney(sale.totalIncl)}
                    </span>
                  </span>
                }
                onClick={() => onPrint(sale)}
              />
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}

/**
 * A stored date, shown plainly.
 *
 * Split rather than parsed into a Date: the column is a DATE, and `new Date('…')`
 * on one is read as UTC midnight, which renders as the previous day for anybody
 * behind it. That is a real bug this app has already been bitten by.
 */
function formatDate(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split('-')
  return day && month && year ? `${day}/${month}/${year}` : iso
}

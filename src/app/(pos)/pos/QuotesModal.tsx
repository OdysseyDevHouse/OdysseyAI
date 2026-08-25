'use client'

import { useEffect, useState } from 'react'
import {
  Modal,
  Button,
  Badge,
  Icons,
  TouchRow,
  CategoryTile,
  EmptyState,
  Skeleton,
  ToolbarSearch,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { QUOTE_STATE_LABELS, QUOTE_STATE_TONES } from '@/lib/quotesModel'
import { listTillQuotesAction, type TillQuote } from './quoteActions'

/**
 * The shop's quotes, at the counter.
 *
 * ── WHAT THIS IS FOR ──────────────────────────────────────────────────────
 *
 * A customer walks in holding a quote — printed, emailed, or just a number on
 * their phone — and wants to buy what is on it. The cashier finds it here and
 * taps it; its lines become the basket, priced against today's product file,
 * and the sale proceeds like any other.
 *
 * The back office has a register for the same quotes, built for a manager
 * working a pipeline. This is the same data for somebody with a customer
 * waiting: bigger rows, one search box, and no columns to read.
 *
 * ── WHY THE WHOLE SHOP'S ──────────────────────────────────────────────────
 *
 * Not this till's. A quote written at the front counter belongs to the shop,
 * and a customer who walks up to the back one must not be sent away over which
 * machine happened to take their details.
 *
 * ── AND WHY SETTLED ONES ARE SHOWN BUT NOT TAPPABLE ───────────────────────
 *
 * An accepted quote is already an invoice; pulling its lines onto a till would
 * sell the same goods twice. A declined one was answered. Both are still
 * LISTED, though — the customer is standing there insisting their quote exists,
 * and a cashier who cannot find it will assume the system has lost it and start
 * keying the items in by hand, which is the double sale arriving by another
 * road. So they are shown, badged with what happened, and inert.
 */
export function QuotesModal({
  open,
  onClose,
  onRecall,
  busy,
}: {
  open: boolean
  onClose: () => void
  /** Pulls the quote onto the basket. The shell owns what that means. */
  onRecall: (quote: TillQuote) => void
  busy: boolean
}) {
  const [quotes, setQuotes] = useState<TillQuote[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')

  /*
   * Read on open and on every search, debounced.
   *
   * Searched on the SERVER rather than filtered in the browser: the list is
   * capped at 100 and a shop with more quotes than that would have a search box
   * that only looked through the first hundred — which is the kind of wrong
   * that is invisible until the one quote somebody wants is the 101st.
   */
  useEffect(() => {
    if (!open) return
    setLoading(true)
    const timer = setTimeout(() => {
      listTillQuotesAction(search.trim() || undefined)
        .then(setQuotes)
        .catch(() => setQuotes([]))
        .finally(() => setLoading(false))
    }, search ? 300 : 0)
    return () => clearTimeout(timer)
  }, [open, search])

  /* A fresh panel every time. Reopening onto somebody else's search term is a
     list that appears to have lost quotes that are sitting right there. */
  useEffect(() => {
    if (!open) setSearch('')
  }, [open])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Quotes"
      description="Tap one to bring it onto the till. It stays a quote until you take the money."
      size="lg"
      /* An unbounded list of documents on a touch screen: the more rows a
         cashier can see without dragging, the faster the handover. */
      bodyGrows
      footer={
        <Button variant="secondary" size="touch" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        {/* Full width, overriding the toolbar default of w-64: that width is for
            a control sitting in a row of others on a back-office toolbar, and
            this one has a whole dialog to itself and a finger aiming at it. */}
        <ToolbarSearch
          value={search}
          onChange={setSearch}
          placeholder="Quote number, customer or reference"
          className="w-full"
          aria-label="Search quotes"
        />

        {loading && quotes.length === 0 && (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-touch w-full rounded-card" />
            ))}
          </div>
        )}

        {!loading && quotes.length === 0 && (
          <EmptyState
            icon={<Icons.FileText size={26} />}
            title={search ? 'Nothing matches that' : 'No quotes yet'}
            hint={
              search
                ? 'Try the quote number, or part of the customer name.'
                : 'Switch the till to Quotes, ring up what the customer asked about, and save it.'
            }
          />
        )}

        {quotes.map((q) => (
          <TouchRow
            key={q.id}
            icon={
              <CategoryTile
                icon={<Icons.FileText size={20} />}
                /* Settled quotes read as finished rather than actionable, which
                   is what they are — the till has nothing left to do with one. */
                tone={q.recallable ? 'indigo' : 'emerald'}
                size="lg"
              />
            }
            title={`${q.documentNumber ?? 'Unnumbered'} · ${q.customerName ?? 'No customer'}`}
            subtitle={subtitleFor(q)}
            trailing={
              <span className="flex items-center gap-2">
                {/* Tone and label both from the shared model, so this row and the
                    back-office register cannot disagree about a quote. */}
                <Badge tone={QUOTE_STATE_TONES[q.state]}>{QUOTE_STATE_LABELS[q.state]}</Badge>
                <span className="numeric text-base font-medium text-ink">
                  {formatMoney(q.totalIncl)}
                </span>
              </span>
            }
            /* No chevron on a settled quote. It is the mark that says "this
               opens something", and on a row that cannot be tapped it promises
               a screen that will never arrive. */
            showChevron={q.recallable}
            /* Inert rather than absent — see the header. */
            disabled={!q.recallable || busy}
            onClick={() => onRecall(q)}
          />
        ))}
      </div>
    </Modal>
  )
}

/**
 * The line under the quote number.
 *
 * Says WHEN it runs out, in the words somebody would use out loud. A date alone
 * ("2026-09-02") makes a cashier do the arithmetic while a customer waits, and
 * the answer they need is almost always "is this still good".
 */
function subtitleFor(q: TillQuote): string {
  if (q.state === 'accepted') return 'Already invoiced'
  if (q.state === 'declined') return 'The customer said no'
  if (q.validUntil === null) return 'No expiry date'

  const days = q.daysRemaining
  if (days === null) return `Valid until ${q.validUntil}`
  if (days < 0) return `Expired ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`
  if (days === 0) return 'Expires today'
  if (days === 1) return 'Expires tomorrow'
  return `${days} days left`
}

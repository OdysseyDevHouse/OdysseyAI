'use client'

import { useEffect, useState } from 'react'
import {
  Badge,
  Button,
  CategoryTile,
  EmptyState,
  Icons,
  Modal,
  Skeleton,
  TouchRow,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { listSavedSalesAction, type SavedSaleRow } from './actions'

/**
 * Baskets set aside, so the next customer can be served.
 *
 * The case this exists for: somebody has forgotten their wallet, or wants to add
 * one more thing from the back of the shop, and there are three people behind
 * them. The basket is parked and the queue moves.
 *
 * Nothing about a parked sale has happened yet — no stock has moved, no number
 * has been issued, and `status = 'saved'` is what says so. That is why discarding
 * one is a plain delete rather than a void: there is nothing to reverse.
 *
 * Only THIS till's parked sales, when the machine has claimed one. A cashier
 * looking for the basket they parked two minutes ago should not have to read past
 * every other till's. A machine with no terminal sees them all, because it has no
 * basis on which to narrow the list.
 */
/**
 * One row in the list, from either source.
 *
 * A discriminated `where` rather than an overloaded id: a server basket is keyed by a
 * numeric document id and a local one by a uid string, and a single field holding
 * "either" is how a recall ends up calling the wrong one. The union makes the caller
 * say which it means.
 */
export type SavedEntry = {
  key: string
  where: 'server' | 'till'
  documentId: number | null
  uid: string | null
  customerName: string | null
  totalIncl: number
  lineCount: number
  at: Date | string | null
}

function fromServer(row: SavedSaleRow): SavedEntry {
  return {
    key: `s:${row.id}`,
    where: 'server',
    documentId: row.id,
    uid: null,
    customerName: row.customerName,
    totalIncl: row.totalIncl,
    lineCount: row.lineCount,
    at: row.updatedAt,
  }
}

export function SavedSalesModal({
  open,
  terminalId,
  busy,
  online,
  localBaskets,
  onClose,
  onRecall,
  onDiscard,
  onCount,
}: {
  open: boolean
  /** Narrows the list to one till. Null shows every parked sale. */
  terminalId: number | null
  busy: boolean
  /**
   * Whether the server can be asked.
   *
   * Offline the list is whatever this till parked locally — and it says so, because a
   * cashier hunting for a basket they parked on another machine needs to know it
   * cannot be here rather than concluding it was lost.
   */
  online: boolean
  /** Baskets parked on THIS till while it had no network. */
  localBaskets: SavedEntry[]
  onClose: () => void
  onRecall: (entry: SavedEntry) => void
  onDiscard: (entry: SavedEntry) => void
  /**
   * How many were actually found.
   *
   * Reported back so the badge on the till agrees with this list — they are drawn
   * from the same query, and a badge saying 2 beside a list of 1 reads as a lost
   * basket.
   */
  onCount: (n: number) => void
}) {
  const [serverRows, setServerRows] = useState<SavedEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)

  // Re-read on every open rather than cached: another till can park or take a
  // sale while this basket sits open, and a stale list offers a basket that is
  // no longer there.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setConfirming(null)

    // Offline there is nothing to ask. Skipped rather than attempted-and-caught so
    // the list paints immediately instead of after a four-second timeout.
    if (!online) {
      setServerRows([])
      setLoading(false)
      onCount(localBaskets.length)
      return
    }

    setLoading(true)
    listSavedSalesAction(terminalId)
      .then((rows) => {
        if (cancelled) return
        const entries = rows.map(fromServer)
        setServerRows(entries)
        onCount(entries.length + localBaskets.length)
      })
      .catch(() => {
        // A failure here is usually the connection going while the modal opened.
        // Fall back to what is local rather than showing an empty list, which reads
        // as "your parked baskets are gone".
        if (cancelled) return
        setServerRows([])
        onCount(localBaskets.length)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // onCount is a fresh arrow each render; listing it would re-run this on every
    // parent render and re-query on every keystroke elsewhere on the till.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, terminalId, online])

  /* Local first. They are the ones this cashier parked on this machine in the last
     few minutes, so they are what they are looking for. */
  const saved = [...localBaskets, ...serverRows]

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Saved sales"
      size="lg"
      footer={
        <Button variant="ghost" size="touch" onClick={onClose}>
          Close
        </Button>
      }
    >
      {loading && saved.length === 0 ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-touch-lg w-full rounded-card" />
          ))}
        </div>
      ) : saved.length === 0 ? (
        <EmptyState
          icon={<Icons.Save size={26} />}
          title="Nothing saved"
          hint="Park a basket with Save when a customer needs to step away, and it will be here."
        />
      ) : (
        <div className="till-pane flex max-h-[52vh] flex-col gap-2 overflow-y-auto">
          {saved.map((doc) => (
            <div key={doc.key} className="flex items-stretch gap-2">
              <TouchRow
                className="flex-1"
                icon={<CategoryTile icon={<Icons.Save size={20} />} tone="amber" size="lg" />}
                title={doc.customerName?.trim() || 'Walk-in'}
                /* Time and item count, because that is how a cashier recognises
                   their own basket: "the one I parked a minute ago with three
                   things in it". A document id would mean nothing to them.

                   A local basket says so: it exists only on this machine, so
                   somebody looking for it at another till needs to know that. */
                subtitle={`${when(doc.at)} · ${doc.lineCount} item${
                  doc.lineCount === 1 ? '' : 's'
                }${doc.where === 'till' ? ' · on this till only' : ''}`}
                trailing={
                  <span className="numeric text-[15px] font-bold text-ink">
                    {formatMoney(doc.totalIncl)}
                  </span>
                }
                disabled={busy}
                onClick={() => onRecall(doc)}
              />

              {/* Discard is a second tap, never a swipe or a long-press: both are
                  gestures a cashier makes by accident while scrolling a list. */}
              {confirming === doc.key ? (
                <Button
                  variant="danger"
                  size="touch-lg"
                  disabled={busy}
                  onClick={() => onDiscard(doc)}
                >
                  Discard?
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="touch-lg"
                  iconOnly
                  aria-label={`Discard the sale for ${doc.customerName || 'Walk-in'}`}
                  disabled={busy}
                  onClick={() => setConfirming(doc.key)}
                >
                  <Icons.Trash size={18} />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

/**
 * "2 minutes ago", "14:32", "yesterday 09:15".
 *
 * Relative while it is recent because that is how a cashier thinks about a basket
 * they just parked, and absolute once it is not — "480 minutes ago" is arithmetic
 * nobody should have to do at a counter.
 */
function when(at: Date | string | null): string {
  if (!at) return 'just now'
  const then = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(then.getTime())) return 'just now'

  const minutes = Math.floor((Date.now() - then.getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`

  const time = then.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const sameDay = then.toDateString() === new Date().toDateString()
  return sameDay ? time : `${then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`
}

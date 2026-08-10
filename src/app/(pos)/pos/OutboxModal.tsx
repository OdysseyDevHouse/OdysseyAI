'use client'

import { useEffect, useState } from 'react'
import {
  Badge,
  Button,
  Callout,
  CategoryTile,
  EmptyState,
  Icons,
  Input,
  Modal,
  TouchRow,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { outboxEntries } from '@/lib/posOffline/cancelOffline'
import type { OutboxSale } from '@/lib/posOffline/types'

/**
 * What this till is still holding.
 *
 * ── WHY A CASHIER NEEDS THIS SCREEN ───────────────────────────────────────
 *
 * The header chip says how many sales are waiting. This says WHICH — and it is the
 * screen somebody opens at closing time to answer "can I cash up yet", or when a sale
 * has been stuck all afternoon and nobody can say why.
 *
 * ── AND THE ONE ACTION IT OFFERS ──────────────────────────────────────────
 *
 * Cancelling a sale that has not synced. There is nothing to void — the sale never
 * reached the server — so the queue entry is re-statused rather than deleted, and it
 * still travels to the audit trail. A till that can make a sale vanish without a trace
 * is a till somebody can steal from, and the person best placed to exploit that is the
 * one standing at it.
 *
 * The number is BURNT, not reused, and the screen says so. That matters because it is
 * the only thing that puts a gap in this till's otherwise gapless invoice run, and a
 * manager reading the register later needs the gap to be explainable rather than
 * mysterious.
 */
export function OutboxModal({
  open,
  siteId,
  busy,
  canCancel,
  onClose,
  onCancelSale,
}: {
  open: boolean
  siteId: number
  busy: boolean
  /**
   * Whether this operator may cancel a queued sale.
   *
   * Gated on `sales.void` — it is the nearest existing right, and making a sale
   * disappear is exactly the kind of thing that capability is for. Checked here only
   * to decide what is OFFERED; the audit row records who did it either way.
   */
  canCancel: boolean
  onClose: () => void
  onCancelSale: (saleUid: string, reason: string) => Promise<void>
}) {
  const [rows, setRows] = useState<OutboxSale[]>([])
  const [loading, setLoading] = useState(false)
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [reason, setReason] = useState('')

  // Re-read on every open. The sync engine changes these rows underneath, and a
  // stale list would offer to cancel a sale that has since posted.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setCancelling(null)
    setReason('')
    outboxEntries(siteId)
      .then((entries) => {
        if (!cancelled) setRows(entries)
      })
      .catch(() => {
        if (!cancelled) setRows([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, siteId])

  const pending = rows.filter((r) => r.status === 'pending')
  const failed = rows.filter((r) => r.status === 'failed')

  async function confirmCancel(saleUid: string) {
    await onCancelSale(saleUid, reason)
    setCancelling(null)
    setReason('')
    setRows(await outboxEntries(siteId).catch(() => []))
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Sales held on this till"
      size="lg"
      footer={
        <Button variant="ghost" size="touch" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        {/* The thing a cashier most needs to be told, and would otherwise learn from
            a cash-up that does not balance. closeShift derives its expected figure
            from posted sales, so an unsynced one makes the drawer read as over. */}
        {pending.length > 0 && (
          <Callout tone="warning" title="Do not cash up yet">
            {pending.length} sale{pending.length === 1 ? '' : 's'} still to send. The
            expected drawer figure is wrong until they are through — it will read as
            over by their value.
          </Callout>
        )}

        {failed.length > 0 && (
          <Callout tone="danger" title="These need somebody">
            {failed.length} sale{failed.length === 1 ? '' : 's'} the server would not
            accept. They are safe here, but they will not send themselves — tell a
            manager.
          </Callout>
        )}

        {!loading && rows.length === 0 ? (
          <EmptyState
            icon={<Icons.Check size={26} />}
            title="Nothing waiting"
            hint="Every sale rung up on this till is on the books."
          />
        ) : (
          <div className="till-pane flex max-h-[52vh] flex-col gap-2 overflow-y-auto">
            {rows.map((row) => (
              <div key={row.saleUid} className="flex flex-col gap-2">
                <div className="flex items-stretch gap-2">
                  <TouchRow
                    className="flex-1"
                    icon={
                      <CategoryTile
                        icon={<Icons.Receipt size={20} />}
                        tone={row.status === 'failed' ? 'rose' : 'sky'}
                        size="lg"
                      />
                    }
                    title={row.documentNumber}
                    subtitle={`${when(row.takenAt)} · ${row.lines.length} item${
                      row.lines.length === 1 ? '' : 's'
                    }${row.lastError ? ` · ${row.lastError}` : ''}`}
                    trailing={
                      <div className="flex items-center gap-2">
                        <span className="numeric text-[15px] font-bold text-ink">
                          {formatMoney(row.claimedTotalIncl)}
                        </span>
                        <StatusBadge row={row} />
                      </div>
                    }
                  />

                  {/* Only a sale that has NOT reached the server can be cancelled
                      here. One that has needs voidDocument, which reverses stock and
                      the ledger — and this screen has neither. */}
                  {canCancel && (row.status === 'pending' || row.status === 'failed') && (
                    <Button
                      variant="ghost"
                      size="touch-lg"
                      iconOnly
                      aria-label={`Cancel ${row.documentNumber}`}
                      disabled={busy}
                      onClick={() =>
                        setCancelling(cancelling === row.saleUid ? null : row.saleUid)
                      }
                    >
                      <Icons.Trash size={18} />
                    </Button>
                  )}
                </div>

                {/* The reason is REQUIRED, and asked for here rather than assumed.
                    A cancelled sale with no explanation tells a manager only that
                    money went missing. */}
                {cancelling === row.saleUid && (
                  <div className="flex flex-col gap-2 rounded-card border border-danger/40 bg-danger-soft px-4 py-3">
                    <p className="text-sm text-danger-ink">
                      This sale never reached the server, so there is nothing to
                      reverse — but <strong>{row.documentNumber} is used up</strong> and
                      will not be issued again. The gap stays on the record, with your
                      reason against it.
                    </p>
                    <Input
                      size="touch"
                      placeholder="Why is this being cancelled?"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                    <div className="flex gap-2">
                      <Button
                        variant="danger"
                        size="touch"
                        className="flex-1 justify-center"
                        disabled={busy || reason.trim().length < 3}
                        onClick={() => void confirmCancel(row.saleUid)}
                      >
                        Cancel this sale
                      </Button>
                      <Button
                        variant="ghost"
                        size="touch"
                        disabled={busy}
                        onClick={() => setCancelling(null)}
                      >
                        Keep it
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}

function StatusBadge({ row }: { row: OutboxSale }) {
  if (row.status === 'synced') return <Badge tone="success">On the books</Badge>
  if (row.status === 'failed') return <Badge tone="danger">Refused</Badge>
  if (row.status === 'cancelled') {
    /* Says which of the two happened to the number, because they mean different
       things to whoever reads the invoice register later. */
    return <Badge tone="neutral">{row.numberBurnt ? 'Cancelled · number used' : 'Cancelled'}</Badge>
  }
  return <Badge tone="warning">To send</Badge>
}

/** "2 minutes ago", "14:32". Relative while recent, absolute once it is not. */
function when(at: string): string {
  const then = Date.parse(at)
  if (!Number.isFinite(then)) return ''
  const mins = Math.floor((Date.now() - then) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`
  return new Date(then).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })
}

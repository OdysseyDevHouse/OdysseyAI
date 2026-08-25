'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  DataTable,
  Field,
  Icons,
  Input,
  Modal,
  SegmentedControl,
  Select,
  TableToolbar,
  ToolbarSearch,
  useToast,
  type BadgeTone,
  type Column,
} from '@/components/ui'
import { formatQty } from '@/lib/decimals'
import { batchTraceAction, writeOffBatchAction, type BatchTraceEvent } from './actions'

type BatchRow = {
  id: number
  productCode: string
  productDescription: string
  locationCode: string | null
  batchNo: string
  expiryDate: string | null
  qtyRemaining: number
  qtyReceived: number
  receivedDocNumber: string | null
  supplierName: string | null
}

/** The outward-facing adjustment reasons a write-off may be filed under. */
type WriteOffReason = { id: number; name: string }

const localToday = (): string => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function expiryBadge(expiry: string | null, days: number): { tone: BadgeTone; label: string } | null {
  if (!expiry) return null
  const today = localToday()
  if (expiry < today) return { tone: 'danger', label: `Expired ${expiry}` }
  const soon = new Date(Date.now() + days * 86_400_000)
  const edge = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, '0')}-${String(soon.getDate()).padStart(2, '0')}`
  if (expiry <= edge) return { tone: 'warning', label: expiry }
  return { tone: 'neutral', label: expiry }
}

export default function BatchesClient({
  batches,
  filter,
  days,
  q,
  canAdjust,
  reasons,
}: {
  batches: BatchRow[]
  filter: string
  days: number
  q: string
  canAdjust: boolean
  reasons: WriteOffReason[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState<BatchRow | null>(null)

  const go = (next: { q?: string; filter?: string; days?: number }) => {
    const params = new URLSearchParams()
    const query = next.q ?? q
    const slice = next.filter ?? filter
    const window = next.days ?? days
    if (query) params.set('q', query)
    params.set('filter', slice)
    if (window !== 30) params.set('days', String(window))
    router.push(`/batches?${params.toString()}`)
  }

  const columns: readonly Column<BatchRow>[] = [
    {
      key: 'batchNo',
      header: 'Lot',
      cell: (r) =>
        r.batchNo ? (
          <span className="numeric">{r.batchNo}</span>
        ) : (
          <Badge tone="warning">Untracked</Badge>
        ),
      sortValue: (r) => r.batchNo,
    },
    { key: 'product', header: 'Product', cell: (r) => r.productDescription, sortValue: (r) => r.productDescription },
    { key: 'code', header: 'Code', cell: (r) => r.productCode, width: 'w-28' },
    {
      key: 'expiry',
      header: 'Expires',
      cell: (r) => {
        const badge = expiryBadge(r.expiryDate, days)
        return badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : '—'
      },
      sortValue: (r) => r.expiryDate ?? '9999',
    },
    { key: 'location', header: 'Location', cell: (r) => r.locationCode ?? '—', width: 'w-24' },
    {
      key: 'remaining',
      header: 'Remaining',
      cell: (r) => formatQty(r.qtyRemaining),
      numeric: true,
      sortValue: (r) => r.qtyRemaining,
    },
    {
      key: 'received',
      header: 'Received on',
      cell: (r) => r.receivedDocNumber ?? '—',
      sortValue: (r) => r.receivedDocNumber ?? '',
    },
  ]

  return (
    <Card>
      <TableToolbar inCard>
        <ToolbarSearch
          value={q}
          onChange={(value) => go({ q: value })}
          placeholder="Lot, code or product…"
          aria-label="Search batches"
        />
        <SegmentedControl
          aria-label="Which lots"
          value={filter}
          onChange={(value) => go({ filter: value })}
          options={[
            { value: 'open', label: 'On the shelf' },
            { value: 'expiring', label: `Expiring (${days}d)` },
            { value: 'expired', label: 'Expired' },
            { value: 'untracked', label: 'Untracked' },
            { value: 'all', label: 'All' },
          ]}
        />
      </TableToolbar>

      <DataTable<BatchRow>
        columns={columns}
        rows={batches}
        getRowKey={(r) => r.id}
        onRowClick={(r) => setOpen(r)}
        empty={{
          title: filter === 'expiring' ? 'Nothing expiring' : 'No lots here',
          hint:
            filter === 'untracked'
              ? 'Untracked buckets appear when stock moves without lot data — a clean book has none.'
              : 'Lots are born when a batch-tracked product is received on a GRV.',
        }}
      />

      {open && (
        <BatchDrawer
          batch={open}
          days={days}
          canAdjust={canAdjust}
          reasons={reasons}
          onClose={() => setOpen(null)}
          onChanged={() => {
            setOpen(null)
            router.refresh()
          }}
        />
      )}
    </Card>
  )
}

/* ── One lot: where it came from and where it went ───────────────────────── */

function BatchDrawer({
  batch,
  days,
  canAdjust,
  reasons,
  onClose,
  onChanged,
}: {
  batch: BatchRow
  days: number
  canAdjust: boolean
  reasons: WriteOffReason[]
  onClose: () => void
  onChanged: () => void
}) {
  const toast = useToast()
  const [events, setEvents] = useState<BatchTraceEvent[] | null>(null)
  const [writeOff, setWriteOff] = useState(false)
  const [reasonId, setReasonId] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const [busy, start] = useTransition()

  // One load per open — the drawer remounts per lot.
  useEffect(() => {
    let cancelled = false
    void batchTraceAction(batch.id).then((result) => {
      if (!cancelled && result.ok) setEvents(result.events)
    })
    return () => {
      cancelled = true
    }
  }, [batch.id])

  function confirmWriteOff() {
    start(async () => {
      const result = await writeOffBatchAction(batch.id, reasonId, note)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(`Lot written off — adjustment ${result.documentNumber}.`)
      onChanged()
    })
  }

  const badge = expiryBadge(batch.expiryDate, days)

  return (
    <Modal
      open
      onClose={onClose}
      title={batch.batchNo ? `Lot ${batch.batchNo}` : 'Untracked stock'}
      description={`${batch.productDescription} · ${formatQty(batch.qtyRemaining)} remaining${batch.supplierName ? ` · from ${batch.supplierName}` : ''}`}
      /* Write-off fields above an unbounded movement history — every receipt,
         sale and adjustment this lot has seen. */
      bodyGrows
      footer={
        writeOff ? (
          <>
            <Button variant="secondary" onClick={() => setWriteOff(false)} disabled={busy}>
              Back
            </Button>
            <Button
              variant="danger"
              onClick={confirmWriteOff}
              disabled={busy || !reasonId || !note.trim() || reasons.length === 0}
            >
              {busy ? 'Posting…' : `Write off ${formatQty(batch.qtyRemaining)}`}
            </Button>
          </>
        ) : (
          <>
            {canAdjust && batch.qtyRemaining > 0 && batch.batchNo && (
              <Button variant="danger-ghost" onClick={() => setWriteOff(true)}>
                Write this lot off
              </Button>
            )}
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
          </>
        )
      }
    >
      {writeOff ? (
        <div className="space-y-3">
          <p className="text-sm text-muted">
            Everything left of this lot comes off the shelf through an ordinary adjustment —
            the recall path. The movement and its reversal live where every adjustment does.
          </p>
          {reasons.length === 0 ? (
            /* No outward reason exists, so the adjustment could never post. Say
               so here rather than letting the button sit dead: the fix is in
               Setup, which is nowhere near this screen. */
            <p className="text-sm text-danger-ink">
              There are no active reasons for stock going out, so this cannot be posted yet.
              Add one under Setup → Adjustment reasons, then come back.
            </p>
          ) : (
            <>
              {/* The reason CODE is what the shrinkage report totals; the note
                  below is what the person reading that line wants next. Both,
                  because neither answers the other's question. */}
              <Field label="Reason" hint="What the write-off is counted as in reporting.">
                <Select
                  autoFocus
                  value={reasonId === null ? '' : String(reasonId)}
                  onChange={(e) =>
                    setReasonId(e.target.value === '' ? null : Number(e.target.value))
                  }
                >
                  <option value="">Choose a reason…</option>
                  {reasons.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </Select>
              </Field>
              {/* Not a second "why" — the reason above is the CATEGORY that
                  totals in reporting, and this is the specifics that category
                  cannot carry. Labelled apart so the panel does not read as
                  asking the same question twice. */}
              <Field label="Details" hint="The specifics the reason cannot carry — a notice or claim number.">
                <Input
                  value={note}
                  maxLength={150}
                  placeholder="e.g. Supplier recall notice 2026-08"
                  onChange={(e) => setNote(e.target.value)}
                />
              </Field>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
            {batch.receivedDocNumber && (
              <Badge tone="neutral">Received on {batch.receivedDocNumber}</Badge>
            )}
            <Badge tone="neutral">
              {formatQty(batch.qtyRemaining)} of {formatQty(batch.qtyReceived)} left
            </Badge>
          </div>

          {events === null ? (
            <p className="text-sm text-muted">Loading its history…</p>
          ) : events.length === 0 ? (
            <p className="text-sm text-muted">No movements recorded for this lot yet.</p>
          ) : (
            <ul className="divide-y divide-border rounded-card border border-border">
              {events.map((event, index) => (
                <li key={index} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0">
                    <span className="font-medium text-ink">{ACTION_LABEL[event.action] ?? event.action}</span>
                    <span className="ml-2 text-xs text-muted">
                      {event.documentNumber ?? event.note ?? event.userName}
                    </span>
                    {/* A sale whose lot nobody read off the pack (234). Said on
                        the line rather than in a footnote, because this is the
                        row somebody would otherwise phone a customer about. */}
                    {!event.observed && (
                      <span className="ml-2 align-middle">
                        <Badge tone="warning">Inferred</Badge>
                      </span>
                    )}
                  </span>
                  <span
                    className={`numeric shrink-0 ${event.qty < 0 ? 'text-danger-ink' : 'text-success-ink'}`}
                  >
                    {event.qty > 0 ? '+' : ''}
                    {formatQty(event.qty)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/* Only when at least one line actually is inferred — a permanent
              caveat about a shop that scans every lot is noise, and noise is
              what stops the next caveat being read. */}
          {events !== null && events.some((event) => !event.observed) && (
            <p className="text-xs text-muted">
              A sale marked <strong className="text-ink-2">Inferred</strong> was booked against
              this lot because it was the one expiring soonest — nobody recorded which pack left
              the shelf. Treat those as a strong lead rather than proof. Setup → Stock tracking
              turns lot capture on.
            </p>
          )}
        </div>
      )}
    </Modal>
  )
}

const ACTION_LABEL: Record<string, string> = {
  receipt: 'Received',
  sale: 'Sold',
  sale_return: 'Returned',
  adjustment: 'Adjusted',
  transfer_in: 'Transferred in',
  transfer_out: 'Transferred out',
  manufacture_in: 'Built',
  manufacture_out: 'Used in a build',
  opening: 'Opening stock',
}

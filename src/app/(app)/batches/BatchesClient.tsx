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
}: {
  batches: BatchRow[]
  filter: string
  days: number
  q: string
  canAdjust: boolean
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
      <TableToolbar>
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
  onClose,
  onChanged,
}: {
  batch: BatchRow
  days: number
  canAdjust: boolean
  onClose: () => void
  onChanged: () => void
}) {
  const toast = useToast()
  const [events, setEvents] = useState<BatchTraceEvent[] | null>(null)
  const [writeOff, setWriteOff] = useState(false)
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
      const result = await writeOffBatchAction(batch.id, note)
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
      footer={
        writeOff ? (
          <>
            <Button variant="secondary" onClick={() => setWriteOff(false)} disabled={busy}>
              Back
            </Button>
            <Button variant="danger" onClick={confirmWriteOff} disabled={busy || !note.trim()}>
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
          <Field label="Why" hint="This goes on the adjustment, word for word.">
            <Input
              autoFocus
              value={note}
              maxLength={150}
              placeholder="e.g. Supplier recall notice 2026-08"
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
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

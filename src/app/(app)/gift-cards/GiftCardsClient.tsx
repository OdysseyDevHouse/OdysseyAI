'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CurrencyInput,
  DataTable,
  Field,
  Icons,
  Input,
  Modal,
  NumberInput,
  SegmentedControl,
  TableToolbar,
  ToolbarSearch,
  useToast,
  type BadgeTone,
  type Column,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import {
  generateGiftCardsAction,
  adjustGiftCardAction,
  voidGiftCardAction,
  runGiftCardExpiryAction,
  giftCardEventsAction,
} from './actions'

type CardRow = {
  id: number
  code: string
  status: 'pending' | 'active' | 'redeemed' | 'expired' | 'void'
  initialValue: number
  balance: number
  expiresOn: string | null
  activatedDocNumber: string
  note: string
}

type EventRow = {
  id: number
  entryType: string
  amount: number
  documentNumber: string
  note: string
  userName: string
  createdAt: Date
}

const STATUS_TONE: Record<CardRow['status'], BadgeTone> = {
  pending: 'neutral',
  active: 'success',
  redeemed: 'default',
  expired: 'warning',
  void: 'danger',
}

const STATUS_LABEL: Record<CardRow['status'], string> = {
  pending: 'Unsold',
  active: 'Active',
  redeemed: 'Used up',
  expired: 'Expired',
  void: 'Cancelled',
}

const display = (code: string) => code.replace(/(.{4})(?=.)/g, '$1-')

export default function GiftCardsClient({
  cards,
  canManage,
}: {
  cards: CardRow[]
  canManage: boolean
}) {
  const toast = useToast()
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [search, setSearch] = useState('')
  const [slice, setSlice] = useState<'all' | 'active' | 'pending' | 'finished'>('all')
  const [generating, setGenerating] = useState(false)
  const [openCard, setOpenCard] = useState<CardRow | null>(null)

  const rows = useMemo(() => {
    const term = search.trim().toUpperCase().replace(/[\s-]/g, '')
    return cards.filter((c) => {
      if (slice === 'active' && c.status !== 'active') return false
      if (slice === 'pending' && c.status !== 'pending') return false
      if (slice === 'finished' && !['redeemed', 'expired', 'void'].includes(c.status)) return false
      if (term && !c.code.includes(term) && !c.activatedDocNumber.toUpperCase().includes(term)) {
        return false
      }
      return true
    })
  }, [cards, search, slice])

  function runExpiry() {
    startTransition(async () => {
      const result = await runGiftCardExpiryAction()
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      if (result.cards === 0) {
        toast.info('Nothing has lapsed — every active card is still in date.')
      } else {
        toast.success(
          `${result.cards} card${result.cards === 1 ? '' : 's'} expired — ${formatMoney(result.value)} to breakage.`,
        )
      }
      router.refresh()
    })
  }

  return (
    <Card>
      <TableToolbar
        actions={
          canManage ? (
            <>
              <Button variant="ghost" size="sm" disabled={pending} onClick={runExpiry}>
                <Icons.History size={15} />
                Run expiry
              </Button>
              <Button variant="primary" size="sm" onClick={() => setGenerating(true)}>
                <Icons.Plus size={15} />
                Generate cards
              </Button>
            </>
          ) : undefined
        }
      >
        <ToolbarSearch
          value={search}
          onChange={setSearch}
          placeholder="Card number or invoice…"
          aria-label="Search gift cards"
        />
        <SegmentedControl
          aria-label="Which cards"
          value={slice}
          onChange={(v) => setSlice(v as typeof slice)}
          options={[
            { value: 'all', label: 'All' },
            { value: 'active', label: 'Active' },
            { value: 'pending', label: 'Unsold' },
            { value: 'finished', label: 'Finished' },
          ]}
        />
      </TableToolbar>

      <DataTable<CardRow>
        columns={COLUMNS}
        rows={rows}
        getRowKey={(r) => r.id}
        onRowClick={(r) => setOpenCard(r)}
        empty={{
          title: 'No gift cards yet',
          hint: canManage
            ? 'Generate a batch of cards, or sell one straight from the till — a gift-card product asks for the number as it rings up.'
            : 'Cards appear here once the shop starts selling them.',
        }}
      />

      {generating && (
        <GenerateModal
          onClose={() => setGenerating(false)}
          onDone={() => {
            setGenerating(false)
            router.refresh()
          }}
        />
      )}

      {openCard && (
        <CardDrawer
          card={openCard}
          canManage={canManage}
          onClose={() => setOpenCard(null)}
          onChanged={() => {
            setOpenCard(null)
            router.refresh()
          }}
        />
      )}
    </Card>
  )
}

const COLUMNS: readonly Column<CardRow>[] = [
  {
    key: 'code',
    header: 'Card',
    cell: (r) => <span className="numeric">{display(r.code)}</span>,
    sortValue: (r) => r.code,
  },
  {
    key: 'status',
    header: 'Status',
    cell: (r) => (
      <Badge tone={STATUS_TONE[r.status]} dot>
        {STATUS_LABEL[r.status]}
      </Badge>
    ),
    sortValue: (r) => r.status,
    width: 'w-28',
  },
  {
    key: 'balance',
    header: 'Holding',
    cell: (r) => (r.status === 'pending' ? '—' : formatMoney(r.balance)),
    numeric: true,
    sortValue: (r) => r.balance,
  },
  {
    key: 'initialValue',
    header: 'Sold at',
    cell: (r) => (r.initialValue > 0 ? formatMoney(r.initialValue) : '—'),
    numeric: true,
    sortValue: (r) => r.initialValue,
  },
  {
    key: 'expiresOn',
    header: 'Valid until',
    cell: (r) => r.expiresOn ?? '—',
    sortValue: (r) => r.expiresOn ?? '',
  },
  {
    key: 'doc',
    header: 'Sold on',
    cell: (r) => r.activatedDocNumber || '—',
    sortValue: (r) => r.activatedDocNumber,
  },
]

/* ── Generating stock ─────────────────────────────────────────────────────── */

function GenerateModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [count, setCount] = useState(10)
  const [note, setNote] = useState('')
  const [codes, setCodes] = useState<string[] | null>(null)
  const [busy, start] = useTransition()

  function generate() {
    start(async () => {
      const result = await generateGiftCardsAction(count, note)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setCodes(result.codes)
    })
  }

  return (
    <Modal
      open
      onClose={codes ? onDone : onClose}
      title="Generate gift cards"
      description="A batch of unsold cards — the box of plastic behind the counter."
      footer={
        codes ? (
          <Button variant="primary" onClick={onDone}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={generate} disabled={busy || count < 1}>
              {busy ? 'Generating…' : `Generate ${count}`}
            </Button>
          </>
        )
      }
    >
      {codes ? (
        <div className="space-y-3">
          <p className="text-sm text-muted">
            {codes.length} card{codes.length === 1 ? '' : 's'} generated. Copy the numbers now —
            they are also on the list behind this dialog.
          </p>
          <ul className="numeric max-h-60 overflow-y-auto rounded-control border border-border bg-surface-2 px-3 py-2 text-sm">
            {codes.map((code) => (
              <li key={code}>{display(code)}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="space-y-4">
          <Field label="How many" hint="Up to 500 at a time.">
            <NumberInput
              value={count}
              min={1}
              max={500}
              onChange={(e) => setCount(Number(e.target.value) || 1)}
            />
          </Field>
          <Field label="Note" hint="e.g. which printer batch these went to.">
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={255} />
          </Field>
        </div>
      )}
    </Modal>
  )
}

/* ── One card ─────────────────────────────────────────────────────────────── */

function CardDrawer({
  card,
  canManage,
  onClose,
  onChanged,
}: {
  card: CardRow
  canManage: boolean
  onClose: () => void
  onChanged: () => void
}) {
  const toast = useToast()
  const [events, setEvents] = useState<EventRow[] | null>(null)
  const [adjustAmount, setAdjustAmount] = useState(0)
  const [adjustNote, setAdjustNote] = useState('')
  const [busy, start] = useTransition()

  // One load per open — the drawer remounts per card.
  useEffect(() => {
    let cancelled = false
    void giftCardEventsAction(card.id).then((result) => {
      if (cancelled || !result.ok) return
      setEvents(
        result.events.map((e) => ({
          id: e.id,
          entryType: e.entryType,
          amount: e.amount,
          documentNumber: e.documentNumber,
          note: e.note,
          userName: e.userName,
          createdAt: e.createdAt,
        })),
      )
    })
    return () => {
      cancelled = true
    }
  }, [card.id])

  function adjust() {
    start(async () => {
      const result = await adjustGiftCardAction(card.id, adjustAmount, adjustNote)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Balance adjusted.')
      onChanged()
    })
  }

  function cancel() {
    start(async () => {
      const result = await voidGiftCardAction(card.id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Card cancelled.')
      onChanged()
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Card ${display(card.code)}`}
      description={`${STATUS_LABEL[card.status]}${card.expiresOn ? ` · valid until ${card.expiresOn}` : ''}`}
      footer={
        <>
          {canManage && (card.status === 'pending' || card.status === 'active') && (
            <Button variant="danger-ghost" onClick={cancel} disabled={busy}>
              Cancel the card
            </Button>
          )}
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Close
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-baseline justify-between rounded-card border border-border bg-surface-2 px-4 py-3">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted">Holding</span>
          <span className="numeric text-3xl font-extrabold text-ink">
            {formatMoney(card.balance)}
          </span>
        </div>

        {events === null ? (
          <p className="text-sm text-muted">Loading its history…</p>
        ) : events.length === 0 ? (
          <p className="text-sm text-muted">Nothing has happened to this card yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-card border border-border">
            {events.map((event) => (
              <li key={event.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="font-medium text-ink">{EVENT_LABEL[event.entryType] ?? event.entryType}</span>
                  <span className="ml-2 text-xs text-muted">
                    {event.documentNumber || event.note || event.userName}
                  </span>
                </span>
                <span className={`numeric shrink-0 ${event.amount < 0 ? 'text-danger-ink' : 'text-success-ink'}`}>
                  {event.amount > 0 ? '+' : ''}
                  {formatMoney(event.amount)}
                </span>
              </li>
            ))}
          </ul>
        )}

        {canManage && (card.status === 'active' || card.status === 'redeemed') && (
          <div className="rounded-card border border-border p-3">
            <p className="mb-2 text-sm font-semibold text-ink">Adjust the balance</p>
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Amount" hint="Negative takes value off.">
                <CurrencyInput
                  value={adjustAmount || ''}
                  className="w-32"
                  onChange={(e) => setAdjustAmount(Number(e.target.value) || 0)}
                />
              </Field>
              <div className="min-w-40 flex-1">
                <Field label="Why">
                  <Input
                    value={adjustNote}
                    maxLength={255}
                    placeholder="e.g. goodwill for order 1042"
                    onChange={(e) => setAdjustNote(e.target.value)}
                  />
                </Field>
              </div>
              <Button
                variant="secondary"
                disabled={busy || adjustAmount === 0 || !adjustNote.trim()}
                onClick={adjust}
              >
                Apply
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

const EVENT_LABEL: Record<string, string> = {
  activation: 'Sold and activated',
  redeem: 'Paid for a sale',
  reload: 'Reloaded',
  refund: 'Refund onto the card',
  expire: 'Expired',
  adjust: 'Adjusted by hand',
}

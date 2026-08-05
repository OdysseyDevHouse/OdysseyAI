'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CurrencyInput,
  Field,
  Icons,
  Input,
  Modal,
  Select,
  useToast,
} from '@/components/ui'
import { formatMoney, round } from '@/lib/decimals'
import { openShiftAction, closeShiftAction, drawerMovementAction } from './actions'

/**
 * Counting the drawer.
 *
 * The screen shows EXPECTED only after a figure has been typed for that tender.
 * That is deliberate: showing the expected amount first turns counting into
 * copying, and a cash-up nobody actually counts is worse than none — it looks
 * like a control while proving nothing.
 */

type TenderPosition = {
  tenderTypeId: number
  tenderCode: string
  tenderName: string
  countsAsDrawerCash: boolean
  expected: number
  transactionCount: number
}

type OpenShift = {
  id: number
  terminalCode: string
  userName: string
  openedAt: string
  openingFloat: number
  movementsTotal: number
  expectedCash: number
  takingsTotal: number
  salesCount: number
  tenders: TenderPosition[]
  movements: { id: number; type: string; amount: number; reason: string }[]
}

export default function CashupClient({
  terminals,
  shifts,
  tolerance,
}: {
  terminals: { id: number; code: string; name: string }[]
  shifts: OpenShift[]
  tolerance: number
}) {
  const [opening, setOpening] = useState(false)
  const [counting, setCounting] = useState<OpenShift | null>(null)
  const [moving, setMoving] = useState<OpenShift | null>(null)
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  function run(work: () => Promise<{ ok: true; message: string } | { ok: false; error: string }>) {
    startTransition(async () => {
      const result = await work()
      if (result.ok) {
        toast.success(result.message)
        setOpening(false)
        setCounting(null)
        setMoving(null)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  const busyTills = new Set(shifts.map((s) => s.terminalCode))
  const free = terminals.filter((t) => !busyTills.has(t.code))

  return (
    <>
      <Card>
        <CardHeader
          title="Open shifts"
          description="A shift is one person on one till. Sales are stamped with whichever shift banked them."
          action={
            <Button
              variant="primary"
              onClick={() => setOpening(true)}
              disabled={pending || free.length === 0}
            >
              <Icons.Plus size={15} />
              Open a shift
            </Button>
          }
        />

        {shifts.length === 0 ? (
          <div className="px-6 py-6 text-sm text-muted">
            No shift is open. Sales still post without one — they just will not belong to a
            cash-up.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {shifts.map((shift) => (
              <div key={shift.id} className="px-6 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="font-medium text-ink">
                      {shift.terminalCode} — {shift.userName}
                    </div>
                    <div className="text-xs text-muted">
                      Opened {new Date(shift.openedAt).toLocaleString('en-ZA')} ·{' '}
                      {shift.salesCount} sale{shift.salesCount === 1 ? '' : 's'} ·{' '}
                      {formatMoney(shift.takingsTotal)} taken
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setMoving(shift)}>
                      <Icons.Coins size={15} />
                      Payout
                    </Button>
                    <Button variant="success" size="sm" onClick={() => setCounting(shift)}>
                      <Icons.Check size={15} />
                      Cash up
                    </Button>
                  </div>
                </div>

                <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
                  <Stat label="Float" value={formatMoney(shift.openingFloat)} />
                  {shift.tenders.map((tender) => (
                    <Stat
                      key={tender.tenderTypeId}
                      label={tender.tenderName}
                      value={formatMoney(tender.expected)}
                      hint={`${tender.transactionCount}`}
                    />
                  ))}
                  {shift.movementsTotal !== 0 && (
                    <Stat label="Payouts" value={formatMoney(shift.movementsTotal)} />
                  )}
                </dl>

                {shift.movements.length > 0 && (
                  <ul className="mt-2 flex flex-col gap-0.5 text-xs text-muted">
                    {shift.movements.map((m) => (
                      <li key={m.id}>
                        {m.reason} — {formatMoney(m.amount)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <OpenModal
        open={opening}
        terminals={free}
        pending={pending}
        onClose={() => setOpening(false)}
        onOpen={(terminalId, float) => run(() => openShiftAction(terminalId, float))}
      />

      <CountModal
        shift={counting}
        tolerance={tolerance}
        pending={pending}
        onClose={() => setCounting(null)}
        onClose2={(counted, note) =>
          counting && run(() => closeShiftAction(counting.id, counted, note))
        }
      />

      <MovementModal
        shift={moving}
        pending={pending}
        onClose={() => setMoving(null)}
        onRecord={(input) => moving && run(() => drawerMovementAction(moving.id, input))}
      />
    </>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">
        {label}
        {hint && <span className="ml-1 text-faint">({hint})</span>}
      </dt>
      <dd className="numeric text-ink">{value}</dd>
    </div>
  )
}

function OpenModal({
  open,
  terminals,
  pending,
  onClose,
  onOpen,
}: {
  open: boolean
  terminals: { id: number; code: string; name: string }[]
  pending: boolean
  onClose: () => void
  onOpen: (terminalId: number, float: number) => void
}) {
  const [terminalId, setTerminalId] = useState('')
  const [float, setFloat] = useState(0)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Open a shift"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!terminalId || pending}
            onClick={() => onOpen(Number(terminalId), float)}
          >
            {pending ? 'Opening…' : 'Open'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Till">
          <Select value={terminalId} onChange={(e) => setTerminalId(e.target.value)}>
            <option value="">— Choose —</option>
            {terminals.map((t) => (
              <option key={t.id} value={t.id}>
                {t.code} — {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Opening float"
          hint="Count it. A float that is wrong at the start makes every variance for the shift wrong the same way."
        >
          <CurrencyInput
            value={float}
            onChange={(e) => setFloat(Number(String(e.target.value).replace(',', '.')) || 0)}
          />
        </Field>
      </div>
    </Modal>
  )
}

function CountModal({
  shift,
  tolerance,
  pending,
  onClose,
  onClose2,
}: {
  shift: OpenShift | null
  tolerance: number
  pending: boolean
  onClose: () => void
  onClose2: (counted: { tenderTypeId: number; amount: number }[], note?: string) => void
}) {
  const [counted, setCounted] = useState<Record<number, number>>({})
  const [note, setNote] = useState('')
  const [seeded, setSeeded] = useState<number | null>(null)

  if (shift && seeded !== shift.id) {
    setSeeded(shift.id)
    setCounted({})
    setNote('')
  }
  if (!shift && seeded !== null) setSeeded(null)

  if (!shift) return null

  // Cash carries the float and any payouts; card and EFT are settled by the
  // bank, so they are compared to what was rung up.
  const expectedFor = (t: TenderPosition) =>
    t.countsAsDrawerCash
      ? round(t.expected + shift.openingFloat + shift.movementsTotal, 2)
      : t.expected

  const rows = shift.tenders.map((t) => {
    const typed = counted[t.tenderTypeId]
    const expected = expectedFor(t)
    return {
      tender: t,
      expected,
      counted: typed,
      variance: typed === undefined ? null : round(typed - expected, 2),
    }
  })

  const allCounted = rows.every((r) => r.counted !== undefined)
  const variance = allCounted
    ? rows.reduce((sum, r) => round(sum + (r.variance ?? 0), 2), 0)
    : null
  const outside = variance !== null && Math.abs(variance) > tolerance

  return (
    <Modal
      open={shift !== null}
      onClose={onClose}
      title={`Cash up ${shift.terminalCode}`}
      description="Count the drawer, then enter what you found."
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="success"
            disabled={!allCounted || pending || (outside && !note.trim())}
            onClick={() =>
              onClose2(
                rows.map((r) => ({ tenderTypeId: r.tender.tenderTypeId, amount: r.counted ?? 0 })),
                note.trim() || undefined,
              )
            }
          >
            {pending ? 'Closing…' : 'Close the shift'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {rows.map((row) => (
          <div key={row.tender.tenderTypeId} className="flex flex-col gap-1">
            <Field
              label={row.tender.tenderName}
              hint={
                row.tender.countsAsDrawerCash
                  ? 'Everything in the drawer, including the float.'
                  : 'What the terminal or bank says.'
              }
            >
              <CurrencyInput
                value={row.counted ?? 0}
                onChange={(e) =>
                  setCounted((c) => ({
                    ...c,
                    [row.tender.tenderTypeId]:
                      Number(String(e.target.value).replace(',', '.')) || 0,
                  }))
                }
              />
            </Field>
            {/* Expected appears only AFTER a figure is typed — showing it first
                turns counting into copying. */}
            {row.counted !== undefined && (
              <p className="text-xs text-muted">
                Expected {formatMoney(row.expected)} ·{' '}
                {row.variance === 0 ? (
                  <span className="text-success">exact</span>
                ) : (
                  <span className={row.variance! < 0 ? 'text-danger' : 'text-warning'}>
                    {row.variance! < 0 ? 'short' : 'over'} {formatMoney(Math.abs(row.variance!))}
                  </span>
                )}
              </p>
            )}
          </div>
        ))}

        {variance !== null && (
          <div
            className={`rounded-card px-4 py-3 ${
              variance === 0 ? 'bg-success-soft' : outside ? 'bg-danger-soft' : 'bg-surface-2'
            }`}
          >
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-ink-2">
                {variance === 0 ? 'Balanced' : variance < 0 ? 'Short by' : 'Over by'}
              </span>
              <span className="numeric text-xl font-semibold text-ink">
                {formatMoney(Math.abs(variance))}
              </span>
            </div>
            {outside && (
              <p className="mt-1 text-xs text-ink-2">
                Outside the {formatMoney(tolerance)} tolerance, so an explanation is required.
              </p>
            )}
          </div>
        )}

        {outside && (
          <Field label="What happened?" hint="Recorded against the shift for the manager.">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Note missing, reported to the manager"
            />
          </Field>
        )}
      </div>
    </Modal>
  )
}

function MovementModal({
  shift,
  pending,
  onClose,
  onRecord,
}: {
  shift: OpenShift | null
  pending: boolean
  onClose: () => void
  onRecord: (input: { type: 'payout' | 'payin' | 'drop'; amount: number; reason: string }) => void
}) {
  const [type, setType] = useState<'payout' | 'payin' | 'drop'>('payout')
  const [amount, setAmount] = useState(0)
  const [reason, setReason] = useState('')

  return (
    <Modal
      open={shift !== null}
      onClose={onClose}
      title="Money in or out of the drawer"
      description="Anything that is not a sale, so the cash-up is not blamed for it."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={amount <= 0 || !reason.trim() || pending}
            onClick={() => onRecord({ type, amount, reason })}
          >
            Record
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="What kind">
          <Select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            <option value="payout">Payout — money leaving for an expense</option>
            <option value="payin">Pay-in — money added that is not a sale</option>
            <option value="drop">Drop — moved to the safe</option>
          </Select>
        </Field>
        <Field label="Amount">
          <CurrencyInput
            value={amount}
            onChange={(e) => setAmount(Number(String(e.target.value).replace(',', '.')) || 0)}
          />
        </Field>
        <Field label="Reason">
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Milk for the shop"
          />
        </Field>
      </div>
    </Modal>
  )
}

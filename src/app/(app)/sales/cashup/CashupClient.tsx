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
  EmptyState,
  Field,
  Icons,
  Input,
  MiniStat,
  Modal,
  Select,
  StatTile,
  TableToolbar,
  useToast,
} from '@/components/ui'
import { formatMoney, round } from '@/lib/decimals'
import {
  openShiftAction,
  closeShiftAction,
  drawerMovementAction,
  setCashupModeAction,
} from './actions'

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

type CashupMode = 'terminal' | 'user'

type OpenShift = {
  id: number
  terminalCode: string | null
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
  mode,
  canSetMode,
  terminals,
  shifts,
  tolerance,
}: {
  mode: CashupMode
  canSetMode: boolean
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

  // A till with a shift already on it cannot take another. In user mode no till
  // is claimed at all, so every one of them stays available.
  const busyTills = new Set(shifts.map((s) => s.terminalCode).filter(Boolean))
  const free = mode === 'user' ? terminals : terminals.filter((t) => !busyTills.has(t.code))
  const cannotOpen = pending || (mode === 'terminal' && free.length === 0)

  const openButton = (
    <Button variant="primary" onClick={() => setOpening(true)} disabled={cannotOpen}>
      <Icons.Plus size={15} />
      {mode === 'user' ? 'Start my shift' : 'Open a shift'}
    </Button>
  )

  return (
    <>
      {canSetMode && (
        <ModeCard
          mode={mode}
          disabled={pending || shifts.length > 0}
          onChange={(next) => run(() => setCashupModeAction(next))}
        />
      )}

      {shifts.length === 0 ? (
        <Card>
          <EmptyState
            title="No shift is open"
            hint="Sales still post without one — they just will not belong to a cash-up."
            icon={<Icons.Coins size={22} />}
            action={openButton}
          />
        </Card>
      ) : (
        <>
          <TableToolbar actions={openButton}>
            <p className="text-sm text-muted">
              {mode === 'user'
                ? 'A shift is one person and their own float, across whatever tills they work. Sales follow the PIN that rang them up.'
                : 'A shift is one person on one till. Sales are stamped with whichever shift banked them.'}
            </p>
          </TableToolbar>

          {shifts.map((shift) => (
            <Card key={shift.id}>
              <CardHeader
                title={
                  shift.terminalCode ? `${shift.terminalCode} — ${shift.userName}` : shift.userName
                }
                description={`Opened ${new Date(shift.openedAt).toLocaleString('en-ZA')} · ${shift.salesCount} sale${shift.salesCount === 1 ? '' : 's'} · ${formatMoney(shift.takingsTotal)} taken`}
                action={
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
                }
              />
              <CardBody className="flex flex-col gap-3">
                {/* Expected cash is the figure this screen exists for, so it
                    gets the headline treatment; the rest are working figures. */}
                <StatTile
                  label="Expected cash"
                  value={formatMoney(shift.expectedCash)}
                  hint="What the drawer should hold right now"
                  tone="success"
                  icon={<Icons.Banknote size={16} />}
                />
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <MiniStat label="Float" value={formatMoney(shift.openingFloat)} />
                  {shift.tenders.map((tender) => (
                    <MiniStat
                      key={tender.tenderTypeId}
                      label={`${tender.tenderName} · ${tender.transactionCount}`}
                      value={formatMoney(tender.expected)}
                    />
                  ))}
                  {shift.movementsTotal !== 0 && (
                    <MiniStat label="Payouts" value={formatMoney(shift.movementsTotal)} />
                  )}
                </div>

                {shift.movements.length > 0 && (
                  <ul className="flex flex-col gap-0.5 text-xs text-muted">
                    {shift.movements.map((m) => (
                      <li key={m.id}>
                        {m.reason} — {formatMoney(m.amount)}
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>
          ))}
        </>
      )}

      <OpenModal
        open={opening}
        mode={mode}
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
        onCloseShift={(counted, note) =>
          counting && run(() => closeShiftAction(counting.id, counted, note))
        }
      />

      <MovementModal
        shift={moving}
        mode={mode}
        terminals={terminals}
        pending={pending}
        onClose={() => setMoving(null)}
        onRecord={(input) => moving && run(() => drawerMovementAction(moving.id, input))}
      />
    </>
  )
}

/**
 * How this site reconciles.
 *
 * Lives on the cash-up screen rather than in Setup because it is only
 * comprehensible next to the thing it changes — and because the one moment it
 * may be switched is the moment every shift is closed, which is what this
 * screen already shows.
 */
function ModeCard({
  mode,
  disabled,
  onChange,
}: {
  mode: CashupMode
  disabled: boolean
  onChange: (mode: CashupMode) => void
}) {
  return (
    <Card>
      <CardHeader
        title="How this site cashes up"
        description="Sales bank into whichever shift owns them. Changing this needs every shift closed first."
      />
      <CardBody>
        <div className="flex flex-col gap-3 sm:flex-row">
          {(
            [
              {
                value: 'terminal',
                title: 'By till',
                blurb:
                  'One drawer, counted by whoever is on it. Retail, where a cashier stands at a register.',
                icon: <Icons.Terminal size={16} />,
              },
              {
                value: 'user',
                title: 'By person',
                blurb:
                  'One person and their own float, across whatever tills they work. Hospitality, where waiters share registers.',
                icon: <Icons.Users size={16} />,
              },
            ] as const
          ).map((option) => {
            const active = mode === option.value
            return (
              <button
                key={option.value}
                type="button"
                disabled={disabled || active}
                onClick={() => onChange(option.value)}
                className={`flex flex-1 flex-col gap-1 rounded-card border p-3 text-left transition-colors ${
                  active
                    ? 'border-brand bg-brand-soft'
                    : 'border-border hover:border-brand disabled:hover:border-border'
                } disabled:cursor-not-allowed`}
              >
                <span className="flex items-center gap-2 text-sm font-medium text-ink">
                  {option.icon}
                  {option.title}
                  {active && <Badge tone="brand">In use</Badge>}
                </span>
                <span className="text-xs text-muted">{option.blurb}</span>
              </button>
            )
          })}
        </div>
      </CardBody>
    </Card>
  )
}

function OpenModal({
  open,
  mode,
  terminals,
  pending,
  onClose,
  onOpen,
}: {
  open: boolean
  mode: CashupMode
  terminals: { id: number; code: string; name: string }[]
  pending: boolean
  onClose: () => void
  onOpen: (terminalId: number | null, float: number) => void
}) {
  const [terminalId, setTerminalId] = useState('')
  const [float, setFloat] = useState(0)

  // In user mode the shift belongs to whoever is signed in at the till, so
  // there is nothing to choose — only a float to count.
  const needsTill = mode === 'terminal'

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={needsTill ? 'Open a shift' : 'Start my shift'}
      description={
        needsTill ? undefined : 'The shift belongs to whoever is signed in at the till right now.'
      }
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={(needsTill && !terminalId) || pending}
            onClick={() => onOpen(needsTill ? Number(terminalId) : null, float)}
          >
            {pending ? 'Opening…' : 'Open'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {needsTill && (
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
        )}
        <Field
          label={needsTill ? 'Opening float' : 'Your float'}
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
  onCloseShift,
}: {
  shift: OpenShift | null
  tolerance: number
  pending: boolean
  /** Dismiss without closing anything. */
  onClose: () => void
  /** Actually close the shift with what was counted. */
  onCloseShift: (counted: { tenderTypeId: number; amount: number }[], note?: string) => void
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
      title={`Cash up ${shift.terminalCode ?? shift.userName}`}
      description={
        shift.terminalCode
          ? 'Count the drawer, then enter what you found.'
          : 'Count what you are holding, then enter what you found.'
      }
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
              onCloseShift(
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
                  ? shift.terminalCode
                    ? 'Everything in the drawer, including the float.'
                    : 'Everything you are holding, including your float.'
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
  mode,
  terminals,
  pending,
  onClose,
  onRecord,
}: {
  shift: OpenShift | null
  mode: CashupMode
  terminals: { id: number; code: string; name: string }[]
  pending: boolean
  onClose: () => void
  onRecord: (input: {
    type: 'payout' | 'payin' | 'drop'
    amount: number
    reason: string
    terminalId?: number | null
  }) => void
}) {
  const [type, setType] = useState<'payout' | 'payin' | 'drop'>('payout')
  const [amount, setAmount] = useState(0)
  const [reason, setReason] = useState('')
  const [terminalId, setTerminalId] = useState('')

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
            onClick={() =>
              onRecord({
                type,
                amount,
                reason,
                terminalId: terminalId ? Number(terminalId) : null,
              })
            }
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
        {/* In user mode the shift names no till, so which drawer this came out
            of is otherwise unrecorded — and a waiter paying from their own
            float is a different event from one raiding a register. */}
        {mode === 'user' && (
          <Field label="Out of which drawer" hint="Leave blank if it came from your own float.">
            <Select value={terminalId} onChange={(e) => setTerminalId(e.target.value)}>
              <option value="">My own float</option>
              {terminals.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.code} — {t.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
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

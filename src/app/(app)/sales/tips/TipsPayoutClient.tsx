'use client'

import { useState, useTransition } from 'react'
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Icons,
  Input,
  Modal,
  NumberInput,
  Select,
  StatStrip,
  StatTile,
  SummaryList,
  SummaryRow,
  SummaryTotal,
  useToast,
} from '@/components/ui'
import { formatMoney, round } from '@/lib/decimals'
import {
  loadTipsAction,
  payOutAction,
  splitPoolAction,
  tipDetailAction,
  type TipsState,
  type TipsResult,
} from './actions'
import type { PayoutMethod } from '@/lib/site/tips'

/**
 * Paying tips out.
 *
 * ── WHY THE POOL GETS ITS OWN DIALOG ──────────────────────────────────────
 *
 * A named person's tips are one decision — hand them over — so that is one button. The pool
 * is a different decision: it belongs to nobody until somebody divides it, and the division
 * is the part that needs care. Splitting it through the same "Pay out" button would ask a
 * manager to make two decisions with one tap.
 *
 * The shares must add up to the pool EXACTLY, and the dialog says what is left over as it is
 * typed rather than refusing at the end. The server refuses too — that is the real guard —
 * but a manager should not have to press Pay to discover the arithmetic is off by five rand.
 */

const METHOD_LABELS: Record<PayoutMethod, string> = {
  cash: 'Cash',
  wages: 'With wages',
  transfer: 'Transfer',
  other: 'Other',
}

const SOURCE_LABELS: Record<string, string> = {
  over_tender: 'Kept from an over-payment',
  declared: 'Declared at the till',
  service: 'Service charge',
  manual: 'Added by hand',
}

export default function TipsPayoutClient({
  from,
  to,
  initial,
}: {
  from: string
  to: string
  initial: TipsState
}) {
  const toast = useToast()
  const [pending, start] = useTransition()
  const [range, setRange] = useState({ from, to })
  const [state, setState] = useState(initial)

  /* Which row's Pay dialog is open. The pool is `null`, which is the same convention the
     server and `reassignTip` use — there is no separate flag to disagree with it. */
  const [paying, setPaying] = useState<{ userId: number | null; userName: string } | null>(null)
  const [payOpen, setPayOpen] = useState(false)
  const [method, setMethod] = useState<PayoutMethod>('cash')
  const [note, setNote] = useState('')

  const [splitOpen, setSplitOpen] = useState(false)
  const [shares, setShares] = useState<Record<number, number>>({})

  const [detail, setDetail] = useState<
    { name: string; tips: { id: number; amount: number; source: string; documentNumber: string; date: string }[] } | null
  >(null)

  const apply = (result: TipsResult, done: string) => {
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setState(result.state)
    toast.success(done)
  }

  const reload = (next: { from: string; to: string }) => {
    setRange(next)
    start(async () => {
      const result = await loadTipsAction(next)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setState(result.state)
    })
  }

  const pool = state.owed.find((r) => r.userId === null)
  const named = state.owed.filter((r) => r.userId !== null)
  const totalOwed = round(
    state.owed.reduce((sum, r) => round(sum + r.total, 2), 0),
    2,
  )
  const totalPaid = round(
    state.payouts.reduce((sum, p) => round(sum + p.amount, 2), 0),
    2,
  )

  const allocated = round(
    Object.values(shares).reduce((sum, n) => round(sum + (n || 0), 2), 0),
    2,
  )
  const leftOver = round((pool?.total ?? 0) - allocated, 2)

  const openPay = (userId: number | null, userName: string) => {
    setPaying({ userId, userName })
    setMethod('cash')
    setNote('')
    setPayOpen(true)
  }

  const confirmPay = () => {
    if (!paying) return
    start(async () => {
      const result = await payOutAction({
        userId: paying.userId,
        userName: paying.userName,
        range,
        method,
        note,
      })
      apply(result, `Paid ${paying.userName}.`)
      if (result.ok) setPayOpen(false)
    })
  }

  const openSplit = () => {
    /* Pre-filled with an EQUAL split across everybody, because that is what most shops do
       and re-typing four identical numbers is the kind of friction that gets a screen
       abandoned. The remainder goes on the first share so the total lands exactly — an equal
       division of R100 three ways cannot be three equal numbers. */
    const staff = state.staff
    if (staff.length === 0) {
      toast.error('There are no active staff to split the pool between.')
      return
    }
    const each = round(Math.floor(((pool?.total ?? 0) / staff.length) * 100) / 100, 2)
    const next: Record<number, number> = {}
    staff.forEach((s) => (next[s.id] = each))
    const first = staff[0]
    if (first) {
      next[first.id] = round(each + ((pool?.total ?? 0) - each * staff.length), 2)
    }
    setShares(next)
    setMethod('cash')
    setNote('')
    setSplitOpen(true)
  }

  const confirmSplit = () => {
    const chosen = state.staff
      .filter((s) => (shares[s.id] ?? 0) > 0)
      .map((s) => ({ userId: s.id, userName: s.name, amount: shares[s.id]! }))
    start(async () => {
      const result = await splitPoolAction({ range, method, shares: chosen, note })
      apply(result, 'Pool split and paid out.')
      if (result.ok) setSplitOpen(false)
    })
  }

  const showDetail = (userId: number | null, name: string) => {
    start(async () => {
      const result = await tipDetailAction(userId, range)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setDetail({ name, tips: result.tips })
    })
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardBody className="flex flex-wrap items-end gap-3">
          <Field label="From">
            <Input
              type="date"
              value={range.from}
              onChange={(e) => reload({ ...range, from: e.target.value })}
            />
          </Field>
          <Field label="To">
            <Input
              type="date"
              value={range.to}
              onChange={(e) => reload({ ...range, to: e.target.value })}
            />
          </Field>
          <div className="ml-auto">
            <StatStrip>
              <StatTile label="Owed" value={formatMoney(totalOwed)} icon={<Icons.HandCoins />} />
              <StatTile label="Paid in this period" value={formatMoney(totalPaid)} icon={<Icons.Check />} />
            </StatStrip>
          </div>
        </CardBody>
      </Card>

      {/* ── Owed ── */}
      <Card>
        <CardHeader
          title="Owed"
          description="Tips from finalised sales that have not been paid out yet"
        />
        <CardBody>
          {state.owed.length === 0 ? (
            <EmptyState
              icon={<Icons.HandCoins />}
              title="Nothing outstanding"
              hint="Every tip taken in this period has been paid out."
            />
          ) : (
            /* Roomier than SummaryList's own gap-1.5, which is tuned for rows of text. These
               rows carry a 32px button, so at the default spacing the two rows touch and the
               amount sits hard against the label. */
            <SummaryList className="gap-3">
              {named.map((row) => (
                <SummaryRow
                  key={row.userId}
                  label={
                    <span className="flex flex-col">
                      <span className="text-body">{row.userName}</span>
                      <span className="text-xs text-faint">
                        {row.count} tip{row.count === 1 ? '' : 's'}
                      </span>
                    </span>
                  }
                  value={
                    <span className="flex items-center gap-3">
                      <button
                        type="button"
                        className="text-sm text-muted underline decoration-dotted hover:text-body"
                        onClick={() => showDetail(row.userId, row.userName)}
                      >
                        {formatMoney(row.total)}
                      </button>
                      <Button
                        size="sm"
                        disabled={pending}
                        onClick={() => openPay(row.userId, row.userName)}
                      >
                        Pay out
                      </Button>
                    </span>
                  }
                />
              ))}
              {pool && (
                <SummaryRow
                  label={
                    <span className="flex flex-col">
                      <span className="flex items-center gap-2 text-body">
                        Pool
                        <Badge tone="brand">shared</Badge>
                      </span>
                      <span className="text-xs text-faint">
                        {pool.count} tip{pool.count === 1 ? '' : 's'} nobody is named on
                      </span>
                    </span>
                  }
                  value={
                    <span className="flex items-center gap-3">
                      <button
                        type="button"
                        className="text-sm text-muted underline decoration-dotted hover:text-body"
                        onClick={() => showDetail(null, 'Pool')}
                      >
                        {formatMoney(pool.total)}
                      </button>
                      <Button size="sm" disabled={pending} onClick={openSplit}>
                        Split
                      </Button>
                    </span>
                  }
                />
              )}
              <SummaryTotal label="Total owed" value={formatMoney(totalOwed)} />
            </SummaryList>
          )}
        </CardBody>
      </Card>

      {/* ── Paid ── */}
      <Card>
        <CardHeader title="Paid out" description="Envelopes handed over in this period" />
        <CardBody>
          {/* One line, not a full EmptyState. The kit's empty state is sized for a page's
              MAIN list; used in a subordinate panel its py-16 makes "nothing here" the
              biggest thing on the screen and pushes the real content below the fold. */}
          {state.payouts.length === 0 ? (
            <p className="text-sm text-muted">
              Nothing paid out in this period yet.
            </p>
          ) : (
            <SummaryList>
              {state.payouts.map((p) => (
                <SummaryRow
                  key={p.id}
                  label={
                    <span className="flex flex-col">
                      <span className="flex items-center gap-2 text-body">
                        {p.userName || 'Unnamed'}
                        {p.fromPool && <Badge tone="brand">from the pool</Badge>}
                      </span>
                      <span className="text-xs text-faint">
                        {METHOD_LABELS[p.method]} · {p.paidAt.slice(0, 10)} · by {p.paidByName}
                        {p.note ? ` · ${p.note}` : ''}
                      </span>
                    </span>
                  }
                  value={formatMoney(p.amount)}
                />
              ))}
              <SummaryTotal label="Total paid" value={formatMoney(totalPaid)} />
            </SummaryList>
          )}
        </CardBody>
      </Card>

      {/* ── Earned, for the other question ── */}
      {state.earned.length > 0 && (
        <Card>
          <CardHeader
            title="Earned in this period"
            description="Every tip, paid or not — what each person made rather than what they are still owed"
          />
          <CardBody>
            <SummaryList>
              {state.earned.map((row) => (
                <SummaryRow
                  key={String(row.userId)}
                  label={
                    <span className="flex flex-col">
                      <span className="text-body">{row.userId === null ? 'Pool' : row.userName}</span>
                      <span className="text-xs text-faint">
                        {row.count} tip{row.count === 1 ? '' : 's'}
                      </span>
                    </span>
                  }
                  value={formatMoney(row.total)}
                />
              ))}
            </SummaryList>
          </CardBody>
        </Card>
      )}

      {/* ── Pay one person ── */}
      <Modal
        open={payOpen}
        onClose={() => setPayOpen(false)}
        title={`Pay out ${paying?.userName ?? ''}`}
        description="This marks the tips settled, so they cannot be paid a second time."
        footer={
          <>
            <Button variant="ghost" onClick={() => setPayOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={confirmPay} disabled={pending}>
              {pending ? 'Paying…' : 'Pay out'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Callout tone="neutral">
            {formatMoney(
              state.owed.find((r) => r.userId === (paying?.userId ?? null))?.total ?? 0,
            )}{' '}
            is outstanding. The exact amount is worked out again as it is paid, so a tip rung
            up in the meantime is included rather than left behind.
          </Callout>
          <Field label="How they were paid">
            <Select value={method} onChange={(e) => setMethod(e.target.value as PayoutMethod)}>
              {(Object.keys(METHOD_LABELS) as PayoutMethod[]).map((m) => (
                <option key={m} value={m}>
                  {METHOD_LABELS[m]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Note" hint="Optional — anything worth remembering about this payout.">
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
          </Field>
        </div>
      </Modal>

      {/* ── Split the pool ── */}
      <Modal
        open={splitOpen}
        onClose={() => setSplitOpen(false)}
        title="Split the pool"
        description="Divide the pooled tips between the people who worked for them."
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setSplitOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={confirmSplit} disabled={pending || leftOver !== 0}>
              {pending ? 'Paying…' : 'Pay out the pool'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="space-y-2">
            {state.staff.map((s) => (
              <div key={s.id} className="flex items-center gap-3">
                <span className="flex-1 text-sm">{s.name}</span>
                <div className="w-32">
                  {/* precision=2 so a share reads R22.50 rather than 22.5. On a screen about
                      handing over cash, money with one decimal place looks like a fault. */}
                  <NumberInput
                    value={shares[s.id] ?? 0}
                    precision={2}
                    onChange={(e) => setShares({ ...shares, [s.id]: Number(e.target.value) || 0 })}
                    step={0.01}
                    min={0}
                  />
                </div>
              </div>
            ))}
          </div>
          <SummaryList>
            <SummaryRow label="The pool" value={formatMoney(pool?.total ?? 0)} />
            <SummaryRow label="Allocated" value={formatMoney(allocated)} />
            <SummaryTotal
              label={leftOver === 0 ? 'Nothing left over' : 'Left over'}
              value={formatMoney(leftOver)}
            />
          </SummaryList>
          {leftOver !== 0 && (
            <Callout tone="warning">
              {leftOver > 0
                ? `${formatMoney(leftOver)} of the pool is not allocated to anybody. Every rand has to go somewhere before this can be paid — money marked paid that nobody received cannot be traced back afterwards.`
                : `The shares add up to ${formatMoney(allocated)}, which is ${formatMoney(-leftOver)} more than the pool holds.`}
            </Callout>
          )}
          <Field label="How they were paid">
            <Select value={method} onChange={(e) => setMethod(e.target.value as PayoutMethod)}>
              {(Object.keys(METHOD_LABELS) as PayoutMethod[]).map((m) => (
                <option key={m} value={m}>
                  {METHOD_LABELS[m]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Modal>

      {/* ── What makes up an envelope ── */}
      <Modal
        open={detail !== null}
        onClose={() => setDetail(null)}
        title={`${detail?.name ?? ''} — what is outstanding`}
        description="The individual tips behind the total."
        size="lg"
        footer={
          <Button variant="ghost" onClick={() => setDetail(null)}>
            Close
          </Button>
        }
      >
        {detail && detail.tips.length === 0 ? (
          <EmptyState
            icon={<Icons.HandCoins />}
            title="Nothing outstanding"
            hint="These tips have already been paid out."
          />
        ) : (
          <SummaryList>
            {detail?.tips.map((t) => (
              <SummaryRow
                key={t.id}
                label={
                  <span className="flex flex-col">
                    <span className="text-body">{t.documentNumber}</span>
                    <span className="text-xs text-faint">
                      {String(t.date).slice(0, 10)} · {SOURCE_LABELS[t.source] ?? t.source}
                    </span>
                  </span>
                }
                value={formatMoney(t.amount)}
              />
            ))}
            <SummaryTotal
              label="Total"
              value={formatMoney(
                round(
                  (detail?.tips ?? []).reduce((sum, t) => round(sum + t.amount, 2), 0),
                  2,
                ),
              )}
            />
          </SummaryList>
        )}
      </Modal>
    </div>
  )
}

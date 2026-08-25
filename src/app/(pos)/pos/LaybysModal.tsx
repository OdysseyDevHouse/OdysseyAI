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
  Field,
  CurrencyInput,
  Select,
  Input,
} from '@/components/ui'
import { formatMoney, round } from '@/lib/decimals'
import { listTillLaybysAction, laybyTendersAction, type TillLayby } from './laybyActions'

type Tender = { id: number; name: string; countsAsDrawerCash: boolean }

/**
 * Lay-bys at the counter.
 *
 * ── TWO SCREENS IN ONE DIALOG ─────────────────────────────────────────────
 *
 * The list, and then the one lay-by somebody picked. A cashier's whole
 * interaction is "find theirs, take what they are paying" — pushing that across
 * two dialogs, or out to a separate page, puts a navigation step in the middle
 * of a transaction with a customer waiting.
 *
 * ── AND THE TWO THINGS A COUNTER DOES ─────────────────────────────────────
 *
 * Take a payment, or hand the goods over. They are deliberately separate
 * buttons even when the balance is zero: a customer who has finished paying may
 * be collecting on Saturday, and completing automatically would invoice and move
 * stock for goods still on the shelf. So a settled lay-by says "ready to
 * collect" and waits to be pressed.
 */
export function LaybysModal({
  open,
  onClose,
  onPay,
  onCollect,
  onStartNew,
  basketLines,
  busy,
}: {
  open: boolean
  onClose: () => void
  /** Takes an instalment. The shell owns the round trip and the toast. */
  onPay: (layby: TillLayby, input: { amount: number; tenderTypeId: number; reference: string | null }) => void
  /** Hands the goods over — raises the invoice and moves the stock. */
  onCollect: (layby: TillLayby) => void
  /**
   * Turns the basket on screen into a NEW lay-by.
   *
   * Here as well as on its own quick key, because a quick key is something a
   * shop has to configure and a shop that has configured none would have no way
   * to reach this at all. The list is where somebody already goes to think
   * about lay-bys, so "start one" belongs beside "find one".
   */
  onStartNew: () => void
  /** How many lines are in the basket — nothing to put aside means no button. */
  basketLines: number
  busy: boolean
}) {
  const [laybys, setLaybys] = useState<TillLayby[]>([])
  const [tenders, setTenders] = useState<Tender[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')

  /** The one being paid, or null while the list is showing. */
  const [chosen, setChosen] = useState<TillLayby | null>(null)
  const [amount, setAmount] = useState(0)
  const [tenderId, setTenderId] = useState<number | null>(null)
  const [reference, setReference] = useState('')

  /* Searched on the SERVER, like every other till list: the read is capped at
     100, and filtering in the browser would search only the first hundred. */
  useEffect(() => {
    if (!open) return
    setLoading(true)
    const timer = setTimeout(
      () => {
        listTillLaybysAction(search.trim() || undefined)
          .then(setLaybys)
          .catch(() => setLaybys([]))
          .finally(() => setLoading(false))
      },
      search ? 300 : 0,
    )
    return () => clearTimeout(timer)
  }, [open, search])

  /* The tenders once per opening — a shop's payment methods do not change while
     somebody is standing at the counter. */
  useEffect(() => {
    if (!open) return
    laybyTendersAction()
      .then((rows) => {
        setTenders(rows)
        setTenderId((current) => current ?? rows[0]?.id ?? null)
      })
      .catch(() => setTenders([]))
  }, [open])

  /* A fresh dialog every time. Reopening onto somebody else's search, or worse
     onto their half-typed amount against a different customer's lay-by, is how
     a payment lands on the wrong account. */
  useEffect(() => {
    if (open) return
    setSearch('')
    setChosen(null)
    setReference('')
  }, [open])

  function choose(layby: TillLayby) {
    setChosen(layby)
    /* Defaulted to the WHOLE balance, which is the common case at a counter —
       and freely editable, because paying something off is the other one. */
    setAmount(layby.outstanding)
    setReference('')
  }

  const tender = tenders.find((t) => t.id === tenderId) ?? null
  const overpaying = chosen !== null && amount > chosen.outstanding + 0.004

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={chosen ? (chosen.laybyNumber ?? 'Lay-by') : 'Lay-bys'}
      description={
        chosen
          ? `${chosen.customerName ?? 'No customer'} · ${formatMoney(chosen.outstanding)} outstanding of ${formatMoney(chosen.totalIncl)}`
          : 'Find the customer, then take what they are paying.'
      }
      size="lg"
      /* Two faces, both taller than 60vh: a lay-by list on one and a payment
         form on the other. `bodyGrows` rather than `bodyPins` because the
         payment face is a form, not a list with a fixed header above it. */
      bodyGrows
      footer={
        chosen ? (
          <div className="flex w-full items-center justify-between gap-2">
            <Button variant="secondary" size="touch" onClick={() => setChosen(null)} disabled={busy}>
              <Icons.ArrowLeft size={18} />
              Back
            </Button>
            <div className="flex items-center gap-2">
              {/* Handing over is its own act, available whenever nothing is
                  outstanding — see the header for why it is not automatic. */}
              {chosen.settled && (
                <Button
                  variant="primary"
                  size="touch"
                  disabled={busy}
                  onClick={() => onCollect(chosen)}
                >
                  <Icons.Package size={18} />
                  Hand the goods over
                </Button>
              )}
              <Button
                variant="success"
                size="touch"
                disabled={busy || amount <= 0 || overpaying || !tenderId}
                onClick={() =>
                  tenderId &&
                  onPay(chosen, {
                    amount,
                    tenderTypeId: tenderId,
                    reference: reference.trim() || null,
                  })
                }
              >
                <Icons.Money size={18} />
                Take {formatMoney(amount)}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex w-full items-center justify-between gap-2">
            <Button variant="secondary" size="touch" onClick={onClose}>
              Close
            </Button>
            {/* Only with something to put aside. A "start one" button over an
                empty basket opens a dialog that can only say "ring the goods up
                first", which is a refusal a cashier should not have to trigger
                to learn. */}
            {basketLines > 0 && (
              <Button variant="primary" size="touch" disabled={busy} onClick={onStartNew}>
                <Icons.Plus size={18} />
                Put this basket aside
              </Button>
            )}
          </div>
        )
      }
    >
      {chosen ? (
        <div className="flex flex-col gap-3">
          <Field
            label="How much are they paying?"
            hint="Defaults to the whole balance — change it for a part payment."
            error={overpaying ? `Only ${formatMoney(chosen.outstanding)} is outstanding.` : undefined}
          >
            <CurrencyInput
              value={amount}
              onChange={(e) =>
                setAmount(round(Number(String(e.target.value).replace(',', '.')) || 0, 2))
              }
            />
          </Field>
          <Field label="Paid by">
            <Select
              value={tenderId ?? ''}
              onChange={(e) => setTenderId(Number(e.target.value) || null)}
            >
              {tenders.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          {/* Only where it means something. A cash payment has no reference to
              give, and an optional box on every payment is a box cashiers stop
              reading. */}
          {tender && !tender.countsAsDrawerCash && (
            <Field label="Reference" hint="The card slip or deposit reference.">
              <Input value={reference} onChange={(e) => setReference(e.target.value)} />
            </Field>
          )}
          {chosen.settled && (
            <p className="rounded-card border border-success/40 bg-success-soft px-3 py-2 text-[13px] text-ink">
              This lay-by is paid up. Hand the goods over when the customer has them — that is
              when the invoice is raised and the stock moves.
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <ToolbarSearch
            value={search}
            onChange={setSearch}
            placeholder="Lay-by number, customer name or code"
            className="w-full"
            aria-label="Search lay-bys"
          />

          {loading && laybys.length === 0 && (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-touch w-full rounded-card" />
              ))}
            </div>
          )}

          {!loading && laybys.length === 0 && (
            <EmptyState
              icon={<Icons.Package size={26} />}
              title={search ? 'Nothing matches that' : 'No lay-bys on the go'}
              hint={
                search
                  ? 'Try the lay-by number, or part of the customer name.'
                  : 'Open ones show here until they are collected or cancelled.'
              }
            />
          )}

          {laybys.map((l) => (
            <TouchRow
              key={l.id}
              icon={
                <CategoryTile
                  icon={<Icons.Package size={20} />}
                  /* Green once nothing is owed — that row is a collection
                     rather than a payment, which is a different job. */
                  tone={l.settled ? 'emerald' : l.overdue ? 'rose' : 'amber'}
                  size="lg"
                />
              }
              title={`${l.laybyNumber ?? `Lay-by #${l.id}`} · ${l.customerName ?? 'No customer'}`}
              subtitle={subtitleFor(l)}
              trailing={
                <span className="flex items-center gap-2">
                  {l.settled && <Badge tone="success">Ready to collect</Badge>}
                  {!l.settled && l.overdue && <Badge tone="danger">Overdue</Badge>}
                  <span className="numeric text-base font-medium text-ink">
                    {formatMoney(l.outstanding)}
                  </span>
                </span>
              }
              disabled={busy}
              onClick={() => choose(l)}
            />
          ))}
        </div>
      )}
    </Modal>
  )
}

/**
 * The line under the lay-by number.
 *
 * Leads with what is STILL OWED against the total, because that is the
 * conversation — "you have paid R800 of R2,000" is what a customer asks about,
 * and the outstanding figure alone does not say how far along they are.
 */
function subtitleFor(l: TillLayby): string {
  const progress = `${formatMoney(l.paidTotal)} of ${formatMoney(l.totalIncl)} paid`
  if (l.settled) return `${progress} · nothing left to pay`
  if (l.dueDate) return `${progress} · due ${l.dueDate}`
  return progress
}

'use client'

import { useEffect, useState } from 'react'
import {
  Modal,
  Button,
  Field,
  Input,
  CurrencyInput,
  Badge,
  Icons,
  TouchRow,
  CategoryTile,
  EmptyState,
  Skeleton,
  useToast,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { searchCustomersAction, listTillCustomersAction } from '@/app/(app)/sales/actions'
import type { TillCustomer } from '@/lib/site/tillCustomers'
import type { TenderType } from '@/lib/site/tenderTypes'
import {
  receiptCustomerAction,
  tillCustomerReceiptAction,
  type ReceiptCustomer,
} from './receiptActions'

/**
 * Taking money against a customer's account, without leaving the till.
 *
 * ── WHY THIS IS NOT THE SALE'S CUSTOMER ───────────────────────────────────
 *
 * The account being paid has NOTHING to do with whatever basket is on screen.
 * Somebody walks in holding a statement, pays R2,000, and leaves — there is no
 * sale, and there may be a half-scanned one for somebody else sitting on the till
 * behind this dialog. So this searches every account rather than assuming the
 * attached one, and it neither reads nor touches the basket.
 *
 * It used to send the cashier to /cashbook, which is a back-office screen behind
 * a right they do not hold, on a machine that may have no keyboard.
 *
 * ── PAY OFF vs TOP UP ─────────────────────────────────────────────────────
 *
 * The same money, put in two different places, and the till cannot infer which
 * one somebody meant — a customer owing R200 who hands over R500 might be
 * clearing the bill and leaving R300 on account, or paying a deposit against an
 * order that has not been raised yet. So it is asked, plainly, with the
 * consequence spelled out rather than implied by a word like "allocate".
 */
export function AccountPaymentModal({
  open,
  tenders,
  terminalId,
  onClose,
}: {
  open: boolean
  /** The till's tender list, already filtered for what works offline. */
  tenders: TenderType[]
  terminalId: number | null
  onClose: () => void
}) {
  const toast = useToast()

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<TillCustomer[]>([])
  const [searching, setSearching] = useState(false)
  /** The account chosen, with its balance read fresh. Null while still picking. */
  const [account, setAccount] = useState<ReceiptCustomer | null>(null)
  const [loadingAccount, setLoadingAccount] = useState(false)

  const [amount, setAmount] = useState(0)
  const [tenderTypeId, setTenderTypeId] = useState<number | null>(null)
  const [reference, setReference] = useState('')
  const [allocate, setAllocate] = useState(true)
  const [busy, setBusy] = useState(false)

  /* Everything resets on open. A dialog that remembered the last customer would
     be one keystroke away from receipting the wrong person's money. */
  useEffect(() => {
    if (!open) return
    setQuery('')
    setResults([])
    setAccount(null)
    setAmount(0)
    setReference('')
    setAllocate(true)
    setTenderTypeId(payableTenders(tenders)[0]?.id ?? null)
  }, [open, tenders])

  /*
   * 180ms, the same as every other search on this screen — and it runs on an
   * empty box, asking for the first page of the book rather than showing
   * nothing. See CustomerModal, which does the same for the same reason: the
   * person paying their account at the counter is one of the shop's regulars,
   * and making the cashier guess their spelling to find them is work the list
   * can simply do.
   *
   * Skipped once an account is CHOSEN — the pane below has become the payment
   * form, and there is no list to fill.
   */
  useEffect(() => {
    if (!open || account) {
      setResults([])
      return
    }
    const term = query.trim()
    const timer = setTimeout(() => {
      setSearching(true)
      const lookup = term.length >= 2 ? searchCustomersAction(term) : listTillCustomersAction()
      lookup
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setSearching(false))
    }, 180)
    return () => clearTimeout(timer)
  }, [open, query, account])

  function pick(customer: TillCustomer) {
    setLoadingAccount(true)
    receiptCustomerAction(customer.id)
      .then((found) => {
        if (!found) {
          toast.error('That account could not be read. Try again.')
          return
        }
        setAccount(found)
        /* Pre-filled with what they OWE, because that is what most people are
           here to pay. Editable, and zero when they owe nothing — a prefilled
           amount is a shortcut, never an assumption the cashier cannot override. */
        setAmount(found.balance > 0 ? found.balance : 0)
        /* Nothing outstanding means there is nothing to allocate against, so the
           money can only sit as a credit. Chosen here rather than left for the
           server to correct silently. */
        setAllocate(found.openInvoices.length > 0)
      })
      .catch(() => toast.error('That account could not be read. Try again.'))
      .finally(() => setLoadingAccount(false))
  }

  const options = payableTenders(tenders)
  const tender = options.find((t) => t.id === tenderTypeId) ?? null
  const canTake = account !== null && amount > 0 && tender !== null && !busy

  function take() {
    if (!account || !tender) return
    setBusy(true)
    tillCustomerReceiptAction({
      customerId: account.id,
      amount,
      tenderTypeId: tender.id,
      reference: reference.trim() || null,
      allocate,
      terminalId,
    })
      .then((result) => {
        if (!result.ok) {
          toast.error(result.error)
          return
        }
        /* The NEW balance, not the amount taken. "R2,000 received" tells the
           cashier what they typed; "R2,000 received — R450 still owing" tells the
           customer standing there what they came to find out. */
        toast.success(
          result.newBalance > 0
            ? `${formatMoney(amount)} received from ${account.name}. ${formatMoney(result.newBalance)} still owing.`
            : result.newBalance < 0
              ? `${formatMoney(amount)} received from ${account.name}. ${formatMoney(Math.abs(result.newBalance))} in credit.`
              : `${formatMoney(amount)} received from ${account.name}. Account settled.`,
        )
        onClose()
      })
      .catch(() =>
        toast.error('That payment could not be recorded. Nothing was taken — try again.'),
      )
      .finally(() => setBusy(false))
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Take a payment"
      description="Money against a customer's account. Nothing to do with the sale on screen."
      size="lg"
      /* The body grows and the RESULTS LIST scrolls inside it. On a till the
         search box above must stay put while the rows scroll past — with the
         default cap the whole body scrolled as one and took the field the
         cashier was typing into with it. */
      bodyPins
      footer={
        <>
          <Button variant="ghost" size="touch" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="success"
            size="touch-lg"
            className="flex-1 justify-center"
            disabled={!canTake}
            onClick={take}
          >
            <Icons.HandCoins size={20} />
            {amount > 0 ? `Take ${formatMoney(amount)}` : 'Take payment'}
          </Button>
        </>
      }
    >
      <div className="flex min-h-0 flex-col gap-3">
        {/* ── Who is paying ──────────────────────────────────────────────── */}
        {account ? (
          <div className="flex items-center justify-between gap-3 rounded-card border border-border bg-surface-2 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-base font-medium text-ink">{account.name}</p>
              <p className="truncate text-sm text-muted">
                {account.code} ·{' '}
                {account.balance > 0
                  ? `${formatMoney(account.balance)} owing`
                  : account.balance < 0
                    ? `${formatMoney(Math.abs(account.balance))} in credit`
                    : 'nothing owing'}
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setAccount(null)} disabled={busy}>
              Change
            </Button>
          </div>
        ) : (
          <>
            <Field label="Whose account">
              <Input
                size="touch"
                icon={<Icons.Search size={18} />}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name, code or phone"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>

            {(searching || loadingAccount) && results.length === 0 && (
              <div className="flex flex-col gap-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-touch w-full rounded-card" />
                ))}
              </div>
            )}

            {/* A missed search and an empty book are different problems and get
                different words — see CustomerModal. */}
            {!searching && !loadingAccount && results.length === 0 && (
              <EmptyState
                icon={<Icons.Users size={26} />}
                title={query.trim().length >= 2 ? 'No account found' : 'No accounts yet'}
                hint={
                  query.trim().length >= 2
                    ? 'Only account customers can pay this way. Check the spelling.'
                    : 'Only account customers can pay this way, and none are open yet.'
                }
              />
            )}

            {/* Taller than it was, for the same reason as CustomerModal: the
                list now opens on the book rather than on a few search hits. */}
            {results.length > 0 && (
              <div className="till-pane flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
                {results.map((result) => (
                  <TouchRow
                    key={result.id}
                    icon={<CategoryTile icon={<Icons.Users size={20} />} tone="indigo" size="lg" />}
                    title={result.name}
                    /* The BALANCE, not the credit headroom the sale picker shows.
                       Different question: that one asks "can they take goods", this
                       asks "what do they owe". */
                    subtitle={
                      result.balance > 0
                        ? `${result.code} · ${formatMoney(result.balance)} owing`
                        : `${result.code} · nothing owing`
                    }
                    onClick={() => pick(result)}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {/* ── How much, and how ──────────────────────────────────────────── */}
        {account && (
          <>
            <Field label="Amount">
              <CurrencyInput
                size="touch"
                value={amount}
                onChange={(e) => setAmount(Number(e.target.value.replace(',', '.')) || 0)}
              />
            </Field>

            <Field label="How they are paying">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {options.map((option) => (
                  <Button
                    key={option.id}
                    variant={option.id === tenderTypeId ? 'primary' : 'secondary'}
                    size="touch"
                    className="justify-center"
                    onClick={() => setTenderTypeId(option.id)}
                  >
                    {option.name}
                  </Button>
                ))}
              </div>
            </Field>

            {tender?.requiresReference && (
              <Field label={tender.referenceLabel ?? 'Reference'}>
                <Input
                  size="touch"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  autoComplete="off"
                />
              </Field>
            )}

            {/* ── Against the bill, or onto the account ───────────────────
                Two buttons rather than a switch, because both are ordinary and a
                switch makes one of them look like the exception. The hint says
                what actually happens to the money in each case. */}
            <Field
              label="What it is for"
              hint={
                allocate
                  ? 'Goes against the oldest invoices first.'
                  : 'Sits on the account as a credit, for them to use later.'
              }
            >
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant={allocate ? 'primary' : 'secondary'}
                  size="touch"
                  className="justify-center"
                  disabled={account.openInvoices.length === 0}
                  onClick={() => setAllocate(true)}
                >
                  Pay off the bill
                </Button>
                <Button
                  variant={allocate ? 'secondary' : 'primary'}
                  size="touch"
                  className="justify-center"
                  onClick={() => setAllocate(false)}
                >
                  Top up the account
                </Button>
              </div>
            </Field>

            {account.openInvoices.length > 0 && allocate && (
              <div className="rounded-card border border-border bg-surface-2 p-3">
                <p className="mb-2 text-sm font-medium text-ink-2">Oldest first</p>
                <ul className="flex flex-col gap-1">
                  {account.openInvoices.slice(0, 4).map((invoice) => (
                    <li
                      key={invoice.id}
                      className="flex items-center justify-between gap-3 text-sm text-muted"
                    >
                      <span className="truncate">{invoice.documentNumber ?? 'No number'}</span>
                      <span className="numeric">{formatMoney(invoice.outstanding)}</span>
                    </li>
                  ))}
                </ul>
                {account.openInvoices.length > 4 && (
                  <p className="pt-2 text-sm text-faint">
                    and {account.openInvoices.length - 4} more
                  </p>
                )}
              </div>
            )}

            {account.openInvoices.length === 0 && (
              <Badge tone="neutral">Nothing outstanding — this goes on as a credit.</Badge>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

/**
 * The tenders that can actually settle an account.
 *
 * `postsToDebtor` is excluded because that is the ACCOUNT tender itself — paying
 * an account with the account is a loop, and offering it would produce a refusal
 * from the server that a cashier would read as the till being broken.
 */
function payableTenders(tenders: TenderType[]): TenderType[] {
  return tenders.filter((t) => t.isActive && !t.postsToDebtor)
}

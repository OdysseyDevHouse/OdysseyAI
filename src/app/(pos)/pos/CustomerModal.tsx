'use client'

import { useEffect, useState } from 'react'
import {
  Badge,
  Button,
  Callout,
  CategoryTile,
  EmptyState,
  Field,
  Icons,
  Input,
  Modal,
  Skeleton,
  TouchRow,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { TillCustomer } from '@/lib/site/tillCustomers'
import { searchCustomersAction, listTillCustomersAction } from '@/app/(app)/sales/actions'

/**
 * Who is buying.
 *
 * ── TWO DIFFERENT THINGS, DELIBERATELY KEPT APART ─────────────────────────
 *
 * A WALK-IN is a name typed on the document and nothing more. No account is
 * created, so the debtors book stays a list of real accounts rather than a
 * dumping ground, and the sale has to be paid for now.
 *
 * An ACCOUNT CUSTOMER is a real debtor record. Attaching one is what unlocks the
 * Account tender, and it is why the credit position is shown here rather than
 * discovered at the tender pad: "R1,240 left of R5,000" is the figure a cashier
 * needs BEFORE offering credit, not after the customer has agreed to it.
 *
 * The credit figures shown are a snapshot. `finaliseDocument` re-reads the
 * balance under a lock and refuses the sale if the headroom has gone since —
 * another till can take an order against the same account while this basket sits
 * open. Nothing here is a permission.
 */
export function CustomerModal({
  open,
  customer,
  walkInName,
  onClose,
  onAttach,
  onClear,
  onWalkInName,
}: {
  open: boolean
  customer: TillCustomer | null
  walkInName: string
  onClose: () => void
  onAttach: (customer: TillCustomer) => void
  onClear: () => void
  onWalkInName: (name: string) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<TillCustomer[]>([])
  const [searching, setSearching] = useState(false)
  const [name, setName] = useState(walkInName)

  // Seeded each time it opens rather than held: a name typed and abandoned should
  // not reappear on the next customer's sale.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setResults([])
    setName(walkInName)
  }, [open, walkInName])

  /*
   * Debounced at 180ms, the same as the product search. A cashier types a
   * surname at speed and querying per character is a dozen wasted round trips.
   *
   * ── AND IT RUNS ON AN EMPTY BOX ──────────────────────────────────────────
   *
   * Under two characters this asks for the FIRST PAGE of the book rather than
   * clearing the pane. A picker that opens empty makes the shop's whole debtors
   * list conditional on guessing a spelling, when the account being asked for is
   * nearly always one of the same few dozen — which a list simply shows. A
   * hundred names alphabetically is the whole book for most shops and a starting
   * page for the rest; typing still narrows it the way it always did.
   */
  useEffect(() => {
    if (!open) return
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
  }, [open, query])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Customer"
      size="lg"
      footer={
        <>
          <Button variant="ghost" size="touch" onClick={onClose}>
            Cancel
          </Button>
          {/* Saving the typed name and closing is the walk-in path. It is the
              primary action because most sales are walk-ins, and an empty name
              is a perfectly good walk-in — the document says "Walk-in". */}
          <Button
            variant="primary"
            size="touch-lg"
            className="flex-1 justify-center"
            onClick={() => {
              onWalkInName(name.trim())
              onClose()
            }}
          >
            <Icons.Check size={20} />
            {name.trim() ? `Sell to ${name.trim()}` : 'Walk-in sale'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {/* ── The attached account, when there is one ─────────────────────
            Shown first and shown fully: this is the state the cashier is
            checking, and its credit line is the reason they opened this. */}
        {customer && <AttachedAccount customer={customer} onClear={onClear} />}

        {/* ── A walk-in's name ────────────────────────────────────────────
            Hidden while an account is attached, because the account's own name
            goes on the document and two name fields invite the question of which
            one wins. */}
        {!customer && (
          <Field
            label="Name for the slip"
            hint="Optional. A walk-in creates no account and must be paid for now."
          >
            <Input
              size="touch"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Walk-in"
              autoComplete="off"
            />
          </Field>
        )}

        {/* ── Finding an account ──────────────────────────────────────────── */}
        <Field label="Or attach an account">
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

        {searching && results.length === 0 && (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-touch w-full rounded-card" />
            ))}
          </div>
        )}

        {/* Two different emptinesses, and saying which is the whole job of this
            block: a search that missed is a spelling problem, an empty book is a
            shop that has not opened an account yet. "No account found" under an
            untouched search box would read as the first when it is the second. */}
        {!searching && results.length === 0 && (
          <EmptyState
            icon={<Icons.Users size={26} />}
            title={query.trim().length >= 2 ? 'No account found' : 'No accounts yet'}
            hint={
              query.trim().length >= 2
                ? 'Check the spelling, or sell to them as a walk-in.'
                : 'Accounts are opened in the back office. Anyone else is a walk-in.'
            }
          />
        )}

        {/* Taller than it was: this pane used to hold a few search hits and now
            opens on a hundred names, so the extra rows are the difference
            between scrolling and scrolling twice. */}
        {results.length > 0 && (
          <div className="till-pane flex max-h-96 flex-col gap-2 overflow-y-auto">
            {results.map((result) => (
              <CustomerRow
                key={result.id}
                customer={result}
                onPick={() => {
                  onAttach(result)
                  onClose()
                }}
              />
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}

/* ── One search result ───────────────────────────────────────────────────── */

function CustomerRow({
  customer,
  onPick,
}: {
  customer: TillCustomer
  onPick: () => void
}) {
  const blocked = customer.creditBlockedReason !== null

  return (
    <TouchRow
      icon={<CategoryTile icon={<Icons.Users size={20} />} tone="indigo" size="lg" />}
      title={customer.name}
      /* The code AND the headroom, because both are what a cashier is looking
         for: the code confirms they have the right account, the headroom decides
         whether credit can be offered at all. */
      subtitle={
        blocked
          ? `${customer.code} · ${customer.creditBlockedReason}`
          : `${customer.code} · ${formatMoney(customer.availableCredit)} credit left`
      }
      trailing={
        blocked ? (
          <Badge tone="danger">Blocked</Badge>
        ) : customer.overLimit ? (
          <Badge tone="warning">Over limit</Badge>
        ) : undefined
      }
      /* Attachable even when blocked, deliberately. A blocked account can still
         buy for CASH, and refusing to attach it would stop the sale, hide the
         loyalty balance, and leave the slip nameless. The block bites at the
         tender pad, where the Account key is what it applies to. */
      onClick={onPick}
    />
  )
}

/* ── The account currently attached ──────────────────────────────────────── */

function AttachedAccount({
  customer,
  onClear,
}: {
  customer: TillCustomer
  onClear: () => void
}) {
  return (
    <div className="rounded-card border border-brand/40 bg-brand-soft p-3.5">
      <div className="flex items-start gap-3">
        <CategoryTile icon={<Icons.Users size={20} />} tone="indigo" size="lg" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold text-ink">{customer.name}</p>
          <p className="text-[13px] text-muted">
            {customer.code} · {customer.paymentTermsDays} day terms
          </p>
        </div>
        <Button variant="ghost" size="touch" onClick={onClear}>
          <Icons.Close size={18} />
          Remove
        </Button>
      </div>

      {/* The credit position, as three plain figures. A cashier about to offer
          credit needs the balance and what is left, and a progress bar would say
          less in more space. */}
      <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-brand/25 pt-3 text-[13px]">
        <Figure label="Balance">{formatMoney(customer.balance)}</Figure>
        <Figure label="Limit">{formatMoney(customer.creditLimit)}</Figure>
        <Figure label="Available" tone={customer.availableCredit <= 0 ? 'danger' : 'default'}>
          {formatMoney(customer.availableCredit)}
        </Figure>
      </dl>

      {customer.creditBlockedReason && (
        <div className="mt-3">
          {/* Says what still works, not just what does not. A cashier told only
              "blocked" will turn the customer away; told "cash still fine" they
              complete the sale. */}
          <Callout tone="warning">
            {customer.creditBlockedReason} Cash and card still work — only the
            Account key is refused.
          </Callout>
        </div>
      )}
    </div>
  )
}

function Figure({
  label,
  tone = 'default',
  children,
}: {
  label: string
  tone?: 'default' | 'danger'
  children: React.ReactNode
}) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd
        className={`numeric font-semibold ${tone === 'danger' ? 'text-danger' : 'text-ink'}`}
      >
        {children}
      </dd>
    </div>
  )
}

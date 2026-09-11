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
import {
  customerFileState,
  listOfflineCustomers,
  searchOfflineCustomers,
  type CustomerFileState,
} from '@/lib/posOffline/customers'
import { CustomerEditorModal } from '@/app/(app)/customers/CustomerEditorModal'

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
 *
 * ── AND IT WORKS WITH THE LINE DOWN ───────────────────────────────────────
 *
 * The search falls back to the till's own customer file, which /api/pos/catalog
 * ships (schema 10). Before that it did not, and the consequence was quieter than
 * it sounds: `pos_offline_account_sales` existed, a shop could switch it on, and
 * the tender pad would duly offer Account to a disconnected till — but the only
 * way to ATTACH the customer was this dialog, and this dialog was a server
 * action. The setting was live and unusable at the same time.
 *
 * ── WHAT AN EMPTY RESULT MEANS IS THE HARD PART ───────────────────────────
 *
 * There are now four emptinesses, not two, and telling them apart is most of what
 * this component does. A search that missed, a shop with no accounts, a till that
 * has not synced since the feed existed, and a book too large to hold offline all
 * render as zero rows — and only the first is a spelling problem. A cashier told
 * "No account found" for an account that exists will ring the sale up as cash,
 * and nobody discovers it until the customer queries their statement.
 */
export function CustomerModal({
  open,
  siteId,
  online,
  customer,
  walkInName,
  operatorName,
  onClose,
  onAttach,
  onClear,
  onWalkInName,
  onAttachById,
}: {
  open: boolean
  /** Which shop's stored customer file to read when the line is down. */
  siteId: number
  online: boolean
  customer: TillCustomer | null
  walkInName: string
  /** Named in the audit row when a manager authorises an account edit. */
  operatorName: string
  onClose: () => void
  onAttach: (customer: TillCustomer) => void
  onClear: () => void
  onWalkInName: (name: string) => void
  /**
   * Attach an account by id, re-reading it as a full `TillCustomer`.
   *
   * The editor hands back only `{ id, name }` — it saves through the customer
   * file and knows nothing of credit positions or resolved price structures.
   * Those have to come from `getTillCustomer`, which is what makes an account
   * created here behave identically to one picked off the list.
   */
  onAttachById: (customerId: number) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<TillCustomer[]>([])
  const [searching, setSearching] = useState(false)
  const [name, setName] = useState(walkInName)
  /**
   * Why the stored book cannot answer, when it cannot.
   *
   * Null while online, because then it is not the book being asked. Resolved
   * when the dialog opens rather than when a search comes back empty: the
   * reason is a property of this TILL, not of the search, and reading it on
   * every keystroke would be the same answer twenty times.
   */
  const [fileState, setFileState] = useState<CustomerFileState | null>(null)
  /**
   * The add/edit dialog, and which account it is on.
   *
   * A sibling of this dialog rather than a child of its body: <Modal> is a
   * native <dialog>, and the second one has to reach the top layer in its own
   * right. Nested, it would also unmount the moment this one closes behind it.
   */
  const [editing, setEditing] = useState<{ mode: 'create' | 'edit'; id: number | null } | null>(
    null,
  )

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
      /*
       * Offline: search what is stored. Falling back on a THROW as well as on the
       * known-offline flag, matching the product search in PosShell and for the
       * same reason — a lookup that dies mid-keystroke must show the stored book
       * rather than an empty pane that reads as "no such account".
       */
      const offline = () =>
        term.length >= 2 ? searchOfflineCustomers(siteId, term) : listOfflineCustomers(siteId)
      const server = () =>
        term.length >= 2 ? searchCustomersAction(term) : listTillCustomersAction()
      const lookup = online ? server().catch(offline) : offline()
      lookup
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setSearching(false))
    }, 180)
    return () => clearTimeout(timer)
  }, [open, query, online, siteId])

  /*
   * Why the stored book is empty, asked once per opening.
   *
   * Only while offline. Online the book is not what is being searched, and
   * reporting "this till has never synced" beside results that came from the
   * server would be true and completely beside the point.
   */
  useEffect(() => {
    if (!open || online) {
      setFileState(null)
      return
    }
    let live = true
    void customerFileState(siteId).then((state) => {
      if (live) setFileState(state)
    })
    return () => {
      live = false
    }
  }, [open, online, siteId])

  return (
    <>
    <Modal
      open={open}
      onClose={onClose}
      title="Customer"
      size="lg"
      /* The body grows and the RESULTS LIST scrolls inside it, rather than the
         whole body scrolling as one. On a till the search box and the attached
         account must stay put while a hundred names scroll past them — with
         the default cap the search box scrolled away with the results, which
         on a touch screen means losing the field you are typing into. */
      bodyPins
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
      {/* `min-h-0` so the results pane below can shrink instead of pushing the
          column taller than the panel — the flex default is `min-height:auto`,
          which is what makes a scrolling child grow past its parent instead. */}
      <div className="flex min-h-0 flex-col gap-3">
        {/* ── The attached account, when there is one ─────────────────────
            Shown first and shown fully: this is the state the cashier is
            checking, and its credit line is the reason they opened this. */}
        {customer && (
          <AttachedAccount
            customer={customer}
            online={online}
            onClear={onClear}
            onEdit={() => setEditing({ mode: 'edit', id: customer.id })}
          />
        )}

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

        {/* ── Opening a new account ───────────────────────────────────────────
            Above the results rather than below them: the moment a cashier needs
            this is the moment the search came back empty, and a button under a
            list of a hundred names is a button nobody scrolls to.

            DISABLED rather than hidden when the line is down, and it says why.
            A customer code comes from a server-side sequence, so this genuinely
            cannot work offline — but a vanished button reads as "this shop
            cannot open accounts" and sends someone to the back office to solve
            a problem that fixes itself when the line returns. */}
        <TouchRow
          icon={<CategoryTile icon={<Icons.UserPlus size={20} />} tone="emerald" size="lg" />}
          title="New customer"
          subtitle={
            online
              ? 'Open an account for someone who is not on file'
              : 'Needs a connection — an account cannot be numbered offline'
          }
          tone="bare"
          disabled={!online}
          onClick={() => setEditing({ mode: 'create', id: null })}
        />

        {searching && results.length === 0 && (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-touch w-full rounded-card" />
            ))}
          </div>
        )}

{/* Four different emptinesses, and saying which is the whole job of this
            block.

            The first two are about the SHOP: a search that missed is a spelling
            problem, an empty book is a shop that has not opened an account yet.
            "No account found" under an untouched search box would read as the
            first when it is the second.

            The other two are about this TILL, and they only arise offline — it
            has never synced a customer file, or the shop's book is too large to
            carry one. Both are states in which an account the cashier is looking
            at ON A CARD genuinely exists and this screen cannot find it, so they
            are shown as a WARNING rather than as an empty state. An empty state
            says "there is nothing here"; the truth is "I cannot see it from
            here", and a cashier who reads the first will tell the customer their
            account was closed. */}
        {!searching && results.length === 0 && fileState && !fileState.ok && (
          <Callout tone="warning" title="Not searchable on this till right now">
            {fileState.reason} The sale can still go through as a walk-in, or on
            cash, and the account can be put right in the back office afterwards.
          </Callout>
        )}

        {!searching && results.length === 0 && !(fileState && !fileState.ok) && (
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

        {/* Takes whatever height is left rather than a fixed 384px, so a tall
            till shows twenty names and a short one still works. `min-h-0` is
            what lets it shrink; without it the pane grows to fit its rows and
            the scrollbar lands on the whole body instead, taking the search
            box with it. */}
        {results.length > 0 && (
          <div className="till-pane flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
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

    {/* A SIBLING of the picker, not a child of its body. Both are native
        <dialog> elements, so the editor has to reach the top layer in its own
        right; nested, it would also unmount the instant the picker closes
        behind it. */}
    <CustomerEditorModal
      open={editing !== null}
      mode={editing?.mode ?? 'create'}
      customerId={editing?.id ?? null}
      siteId={siteId}
      operatorName={operatorName}
      size="touch"
      onClose={() => setEditing(null)}
      onSaved={(saved) => {
        setEditing(null)
        /* Re-read as a full TillCustomer before attaching: the editor knows the
           id and the name, and the till needs the credit position and the
           resolved price structure that go with them. */
        onAttachById(saved.id)
        onClose()
      }}
    />
    </>
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
  online,
  onClear,
  onEdit,
}: {
  customer: TillCustomer
  online: boolean
  onClear: () => void
  onEdit: () => void
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
        {/* Icon-only: three full buttons across a card this narrow would wrap,
            and "Edit" beside "Remove" reads as a pair of equal weights when one
            of them is destructive. Disabled offline for the same reason the
            New customer row is — the save needs the line. */}
        <Button
          variant="ghost"
          size="touch"
          iconOnly
          aria-label={`Edit ${customer.name}`}
          title={online ? 'Edit this account' : 'Needs a connection'}
          disabled={!online}
          onClick={onEdit}
        >
          <Icons.Pencil size={18} />
        </Button>
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

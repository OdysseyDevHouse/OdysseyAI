'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardFooter,
  Icons,
  SectionTitle,
  Switch,
} from '@/components/ui'
import type { GroupMember, StoreContents } from '@/lib/storeGroups'
import { updateSharingAction, unlinkStoreAction, type LinkFormState } from './actions'

/**
 * One linked store's sharing settings.
 *
 * "Share products file" is the master switch: with it off the store belongs to
 * the group but exchanges nothing, and the price toggles below have no effect.
 * That is the case for a customer whose fourth branch is run independently.
 *
 * It can only be switched ON while the store is EMPTY. Two stores that each
 * already hold products cannot be merged by a flag — the same code may exist in
 * both with different descriptions and prices, and nothing here could decide
 * which is right. The store is asked, and the toggles are disabled with the
 * counts shown if it is not.
 */

function SaveButton() {
  const { pending } = useFormStatus()
  return (
    // Secondary on purpose: the screen's one primary is "Link store" at the
    // bottom, and four cards each shouting Save would drown it out.
    <Button type="submit" variant="secondary" disabled={pending}>
      {pending ? 'Saving…' : 'Save'}
    </Button>
  )
}

export default function StoreCard({
  member,
  contents,
  isCurrent,
  ownsSharedFiles,
  hasPrimary,
  entityAllows,
}: {
  member: GroupMember
  /** Null when the store has no database to read. */
  contents: StoreContents | null
  isCurrent: boolean
  /**
   * Whether THIS store is the group's primary — the one whose database holds
   * the shared customer and supplier files. Distinct from `isCurrent`, which is
   * merely the store being administered.
   */
  ownsSharedFiles: boolean
  /** Whether the group has chosen a primary at all. */
  hasPrimary: boolean
  /**
   * Whether the group has said its stores are ONE company.
   *
   * Separate companies cannot share a balance without one collecting money it
   * does not own, so the switches are closed rather than merely warned about —
   * and the same rule is enforced in setMemberSharing, because a screen is not
   * a boundary.
   */
  entityAllows: boolean
}) {
  const [state, formAction] = useActionState<LinkFormState, FormData>(updateSharingAction, {
    error: null,
  })

  // Only a store that is not yet sharing has to be empty; one already sharing
  // legitimately fills up and must not become un-saveable.
  // Head office is never blocked by its own products: its catalogue IS the one
  // the branches receive, so there is nothing to merge. Only a BRANCH joining
  // the pool has two populated files that could collide on a code.
  const occupied =
    !ownsSharedFiles &&
    !member.sharesProducts &&
    contents !== null &&
    (contents.products > 0 || contents.departments > 0)

  const blocked = occupied || contents?.readable === false

  /*
   * The customer and supplier files are gated SEPARATELY from products, because
   * they are separate merges. A store can legitimately share products while
   * still holding its own debtors book, and telling someone to delete their
   * products because they have customers would be nonsense.
   *
   * The store that OWNS the files has nothing to merge — the rows are already
   * where they are going — so it is never blocked by its own contents.
   */
  const unreadable = contents?.readable === false
  const customersBlocked =
    !ownsSharedFiles &&
    !member.sharesCustomers &&
    contents !== null &&
    contents.customers > 0
  // No suppliersBlocked: the supplier switch is hidden until the purchasing
  // modules resolve their owner — see the note where it used to be rendered.

  return (
    <Card>
      <SectionTitle
        icon={<Icons.Store size={16} />}
        action={
          !isCurrent && (
            <form action={unlinkStoreAction}>
              <input type="hidden" name="siteId" value={member.siteId} />
              <Button
                type="submit"
                variant="danger-ghost"
                size="sm"
                title="Unlink — neither store's data is changed"
              >
                <Icons.Trash size={14} />
                De-link store
              </Button>
            </form>
          )
        }
      >
        {member.siteCode} — {member.displayName}
        {isCurrent && (
          <Badge tone="brand" className="ml-2">
            This store
          </Badge>
        )}
        {/* Distinct from "This store": the one being administered, and the one
            whose database holds the group's shared files, are different
            questions and are often different shops. */}
        {ownsSharedFiles && (
          <Badge tone="success" className="ml-2">
            Head office
          </Badge>
        )}
        {!member.hasDatabase && (
          <Badge tone="danger" className="ml-2">
            No database
          </Badge>
        )}
      </SectionTitle>

      <form action={formAction}>
        <input type="hidden" name="siteId" value={member.siteId} />

        <CardBody className="flex flex-col gap-4">
          {state.error && <Callout tone="danger">{state.error}</Callout>}

          {blocked && (
            <Callout tone="warning">
              {contents?.readable === false ? (
                <>This store&apos;s database could not be read, so sharing cannot be changed.</>
              ) : (
                <>
                  This store currently has <strong>{contents?.products} product(s)</strong> and{' '}
                  <strong>{contents?.departments} department(s)</strong>. Please delete all
                  products and departments to start using this feature.
                </>
              )}
            </Callout>
          )}

          {/* Named targets, not bare verbs. "Share products file" never said
              WITH WHAT, which is the question somebody actually has — and on
              head office's own card it read as sharing with itself.

              The price switches say what they really do, which is not what
              their old wording implied. They do not decide who CONTROLS a
              price; they decide whether there is ONE figure for the group or a
              separate one per store. */}
          <div className="flex flex-col gap-3">
            {/* ── HEAD OFFICE IS NOT ASKED WHETHER IT SHARES ────────────────
                "Share products with the branches" is not a question anybody can
                answer no to: if a group has a head office, its catalogue is the
                one the branches are choosing whether to use. A switch there
                read as "share with whom?", and switching it off silently
                stopped product edits reaching ANY branch — a group-wide
                consequence hidden behind a per-store control.

                So head office states the fact, and the branches keep the
                switch, because theirs is the real decision. linkedStores()
                includes the primary unconditionally, which is what makes
                removing the control safe. */}
            {ownsSharedFiles ? (
              <>
                <input type="hidden" name="sharesProducts" value="on" />
                <input type="hidden" name="sharesDepartments" value="on" />
                {/* The price flags are not shown here but must still be POSTED:
                    the action reads an absent field as "off", so leaving them
                    out would silently switch off the default that new products
                    created at head office start from. Carried through
                    untouched. */}
                {member.sharesSelling && <input type="hidden" name="sharesSelling" value="on" />}
                {member.sharesCost && <input type="hidden" name="sharesCost" value="on" />}
                <p className="text-sm text-muted">
                  Products and departments created here are offered to the branches.
                  Each branch chooses whether to use them, on its own card below.
                </p>
              </>
            ) : (
              <>
                <SharingSwitch
                  name="sharesProducts"
                  label="Use head office’s product file"
                  hint="Products created by head office appear here. You can still add your own, and only the store that created a product can change it."
                  defaultChecked={member.sharesProducts}
                  disabled={blocked}
                />
                <SharingSwitch
                  name="sharesDepartments"
                  label="Use head office’s departments"
                  hint="Keeps the department structure the same, so a product lands in the same place everywhere."
                  defaultChecked={member.sharesDepartments}
                  disabled={blocked}
                />
              </>
            )}
            {/* ── PRICE IS THE RECEIVING STORE'S DECISION ───────────────────
                Only a BRANCH is asked. That is not a UI preference — it is what
                the fan-out already does: applyToStore reads sharesCost and
                sharesSelling from the TARGET store, so each branch decides for
                itself whether it takes head office's figure or keeps its own.
                Head office's own flags are never consulted when a price travels.

                Leaving them on head office's card implied it could push a price
                down, or refuse to share one, and it can do neither. Its only
                real effect was as a default for products CREATED there, which
                is invisible from a switch labelled "one price for the group". */}
            {!ownsSharedFiles && (
              <>
                <SharingSwitch
                  name="sharesSelling"
                  label="Use head office’s selling price"
                  hint="On: this store sells at head office’s price. Off: this store sets its own selling price for the same product."
                  defaultChecked={member.sharesSelling}
                  disabled={blocked}
                />
                <SharingSwitch
                  name="sharesCost"
                  label="Use head office’s cost price"
                  hint="On: this store takes head office’s cost. Off: this store keeps its own — what it actually pays its supplier."
                  defaultChecked={member.sharesCost}
                  disabled={blocked}
                />
                <p className="text-xs text-muted">
                  These two are the default for new products. Any product can be set
                  differently on its own screen.
                </p>
              </>
            )}
          </div>

          {/* ── HEAD OFFICE HAS NOTHING TO SWITCH ON ────────────────────────
              The customer and supplier files LIVE in head office's database.
              Asking it to tick a box to share them with itself is nonsense —
              it is the file. So it gets a statement instead of a control, and
              is told where the actual decision is made. */}
          {ownsSharedFiles ? (
            <div className="border-t border-border pt-4">
              <p className="text-sm font-medium text-ink">Master files</p>
              <p className="text-xs text-muted mt-0.5">
                The group&apos;s customer and supplier files live here. Switch them on
                at each branch that should use them, on the cards below.
              </p>
            </div>
          ) : (
          /* The master files are a different kind of sharing from products, so
             they sit under their own heading rather than in the list above.
             Products are COPIED to each store; these are not — one store holds
             the file and the others read and write it. */
          <div className="border-t border-border pt-4 flex flex-col gap-3">
            <div>
              <p className="text-sm font-medium text-ink">Master files</p>
              <p className="text-xs text-muted mt-0.5">
                Read head office&apos;s file rather than keeping a copy — so a
                customer&apos;s balance, credit limit and history are the same wherever
                they buy.
              </p>
            </div>

            {/* A disabled control with no stated reason is the thing this
                screen must not do, so each blocker says which one it is. The
                entity answer is checked first because it is the one that can
                make the whole feature inapplicable rather than merely not-yet. */}
            {!entityAllows ? (
              <Callout tone="warning">
                Answer <strong>How are these stores registered?</strong> above first.
                Separate companies cannot share one balance — each collects its own.
              </Callout>
            ) : (
              !hasPrimary && (
                <Callout tone="warning">
                  Choose which store owns the shared files before switching these on.
                </Callout>
              )
            )}

            {customersBlocked && (
              <Callout tone="warning">
                This store has <strong>{contents?.customers} customer(s)</strong> of its own.
                Two customer files cannot be merged automatically — the same code may
                exist in both for different people. Remove them first, or leave this
                store with its own debtors book.
              </Callout>
            )}

            <SharingSwitch
              name="sharesCustomers"
              label="Use head office’s customer file"
              hint="One customer list for the group — buy at one store, pay at another. This store stops keeping its own."
              defaultChecked={member.sharesCustomers}
              disabled={unreadable || customersBlocked || !hasPrimary || !entityAllows}
            />

            {/*
              ── "Use head office's supplier file" is HIDDEN, not removed ──────
              ─────────────────────────────────────────────────────────────────
              The resolver always worked; what was missing was every module
              behind it. Stage one landed the load-bearing half — supplierLedger,
              paymentRuns, purchaseInvoiceMatch and the reconciliation now
              resolve the owner (206, and probe-shared-supplier-file.ts proves
              it) — so the remaining gap is purchasing: suppliers.ts,
              purchaseDocuments, purchasePosting, expenses, supplierPrices,
              productSuppliers and reorderSuggestions still read the branch's
              own database.

              Switching it on today points a branch at head office's supplier
              file while those keep reading their own empty tables: no suppliers
              in the picker, no orders raisable, no invoices matchable. Not a
              subtle wrong answer — purchasing stops.

              Hidden rather than disabled, because a greyed-out switch invites
              "how do I enable this?" and the answer is not a permission or a
              setting, it is unwritten code.

              ── AND WHEN IT RETURNS, THE LABEL HAS TO BE HONEST ──────────────

              The hint this switch used to carry read "One supplier list and one
              creditors book, for central buying." The first half is what the
              feature is; the second half is not what it does.

              purchase_documents, supplier_prices and product_suppliers all STAY
              in the branch — decided, and argued in 206. So orders, agreed
              costs and product-supplier links remain per store: each branch
              orders for itself, at its own costs, into its own stock, with its
              own PO numbers. What IS shared is the creditors book — one supplier
              record, one balance, one ledger, one payment run, so a supplier
              invoiced at branch 3 and paid from branch 7 nets off correctly.

              A shop that switched this on expecting one PO series would find out
              by using it. Whoever restores the switch should write the hint
              about the creditors book and leave central buying out of it — that
              is a separate feature needing a group-wide order document, not a
              routing change.

              THE ACTION NO LONGER SENDS sharesSuppliers — see the note in
              actions.ts. Reading an unrendered field would evaluate to false and
              quietly switch the file off for anyone who had it on.

              Customer sharing above is unaffected and stays available.
            */}
          </div>
          )}
        </CardBody>

        <CardFooter>
          <SaveButton />
        </CardFooter>
      </form>
    </Card>
  )
}

/**
 * A kit Switch inside a plain <form action>. The switch itself is a button and
 * submits nothing, so a hidden input mirrors checkbox semantics — present as
 * "on" when checked, absent when not — which is exactly what the server action
 * reads (`form.get(name) === 'on'`).
 */
function SharingSwitch({
  name,
  label,
  hint,
  defaultChecked,
  disabled,
}: {
  name: string
  label: string
  hint: string
  defaultChecked: boolean
  disabled?: boolean
}) {
  const [checked, setChecked] = useState(defaultChecked)
  return (
    <>
      {checked && <input type="hidden" name={name} value="on" />}
      <Switch
        checked={checked}
        onChange={setChecked}
        label={label}
        hint={hint}
        disabled={disabled}
      />
    </>
  )
}

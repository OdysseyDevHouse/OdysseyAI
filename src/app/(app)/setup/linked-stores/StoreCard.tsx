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
  const suppliersBlocked =
    !ownsSharedFiles && !member.sharesSuppliers && contents !== null && contents.suppliers > 0

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
            <SharingSwitch
              name="sharesSelling"
              label="One selling price for the group"
              hint="On: every store sells at the same price. Off: each store keeps its own selling price for the same product."
              defaultChecked={member.sharesSelling}
              disabled={blocked}
            />
            <SharingSwitch
              name="sharesCost"
              label="One cost price for the group"
              hint="On: one cost across the group. Off: each store keeps its own cost — what it actually pays its supplier."
              defaultChecked={member.sharesCost}
              disabled={blocked}
            />
            <p className="text-xs text-muted">
              The two price switches are the default for new products. Any product
              can be set differently on its own screen.
            </p>
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

            {suppliersBlocked && (
              <Callout tone="warning">
                This store has <strong>{contents?.suppliers} supplier(s)</strong> of its own.
                Remove them first, or leave this store with its own creditors book.
              </Callout>
            )}

            <SharingSwitch
              name="sharesSuppliers"
              label="Use head office’s supplier file"
              hint="One supplier list and one creditors book, for central buying."
              defaultChecked={member.sharesSuppliers}
              disabled={unreadable || suppliersBlocked || !hasPrimary || !entityAllows}
            />
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

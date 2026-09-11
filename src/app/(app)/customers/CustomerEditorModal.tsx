'use client'

import { useEffect, useState } from 'react'
import { Button, Callout, Icons, Modal, Skeleton, useToast } from '@/components/ui'
import type { ControlSize } from '@/components/ui'
import OverrideModal from '@/app/(pos)/pos/OverrideModal'
import type { Customer } from '@/lib/site/customers'
import CustomerForm from './CustomerForm'
import {
  customerFormLookupsAction,
  getCustomerForDialogAction,
  type CustomerFormLookups,
} from './actions'

/**
 * The customer form, as a dialog opened from a till or an invoice.
 *
 * ── THE SAME FORM, NOT A SECOND ONE ───────────────────────────────────────
 *
 * This renders `CustomerForm` — the real one, the one `/customers/new` renders
 * — in its dialog mode. Not a trimmed copy, and deliberately so: a second form
 * with "the fields a counter needs" is a second field list, a second set of
 * defaults and a second place to add the next column, and the two drift within
 * a release. Everything here is chrome around that component.
 *
 * What dialog mode changes is only how the save ENDS: the page form redirects,
 * this one hands the caller `{ id, name }` so the new account can be attached
 * to the sale that prompted it. See `saveCustomerFromDialogAction`.
 *
 * ── ONLINE ONLY, AND SAID OUT LOUD ────────────────────────────────────────
 *
 * A customer code comes from a server-side sequence (`resolveMasterCode`), so
 * an account genuinely cannot be created on a till with no line. The callers
 * therefore DISABLE their button and say why rather than hiding it — a missing
 * button reads as "this shop cannot do that", which sends someone to the back
 * office to solve a problem that will fix itself when the line returns.
 *
 * ── PERMISSION IS A PIN, NOT A WALL ───────────────────────────────────────
 *
 * A cashier without `customers.edit` is not refused; they are asked for a
 * manager. `OverrideModal` mints a two-minute, single-capability token which
 * rides the next save and is verified server-side — a name typed by a client is
 * never what authorises anything. The token is held here rather than in the
 * form so that a manager who authorises once does not have to be fetched back
 * when the save then fails validation.
 */
export function CustomerEditorModal({
  open,
  mode,
  customerId = null,
  siteId,
  operatorName,
  size = 'md',
  onClose,
  onSaved,
}: {
  open: boolean
  mode: 'create' | 'edit'
  /** The account to edit. Ignored when creating. */
  customerId?: number | null
  siteId: number
  /** Named in the override's audit row — "who was at the machine". */
  operatorName: string
  /** `touch` on a till. The form renders every control at 56px. */
  size?: ControlSize
  onClose: () => void
  /** The saved account, so the caller can attach it to the document. */
  onSaved: (customer: { id: number; name: string }) => void
}) {
  const toast = useToast()
  const [lookups, setLookups] = useState<CustomerFormLookups | null>(null)
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [askingManager, setAskingManager] = useState(false)
  /** A manager's say-so for this dialog's next save. '' means none held. */
  const [overrideToken, setOverrideToken] = useState('')

  /*
   * Loaded when the dialog OPENS, not when the component mounts.
   *
   * The callers mount this alongside their picker and leave it mounted, so
   * fetching on mount would pull the groups, reps and price structures on every
   * till that has ever shown a customer dialog — including the ones that never
   * open it. Keyed on `open` and the record, so reopening on a different
   * account re-reads rather than showing the last one's details.
   */
  useEffect(() => {
    if (!open) return

    let live = true
    setLoadError(null)
    setLookups(null)
    setCustomer(null)
    /* A token is authority for ONE save on ONE account. Cleared on every open
       so a manager's approval cannot leak from the customer it was given for
       onto the next one somebody edits. */
    setOverrideToken('')

    const wanted = mode === 'edit' && customerId ? customerId : null

    void Promise.all([
      customerFormLookupsAction(),
      wanted ? getCustomerForDialogAction(wanted) : Promise.resolve(null),
    ])
      .then(([fetchedLookups, fetchedCustomer]) => {
        if (!live) return
        if (wanted && !fetchedCustomer) {
          setLoadError('That account could not be loaded. It may have been closed or removed.')
          return
        }
        setLookups(fetchedLookups)
        setCustomer(fetchedCustomer)
      })
      .catch(() => {
        if (!live) return
        /* The likeliest cause by far is the line, and the remedy is the one
           thing the cashier can act on. Not a toast: the dialog is open and
           empty, so the explanation belongs in it. */
        setLoadError(
          'Could not load the customer form. Check the connection and try again — an account cannot be created while this till is offline.',
        )
      })

    return () => {
      live = false
    }
  }, [open, mode, customerId])

  const isNew = mode === 'create'
  const title = isNew ? 'New customer' : 'Edit customer'
  const ready = lookups !== null

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={title}
        description={
          isNew
            ? 'Opens a real account. Anyone who is not on account is a walk-in.'
            : undefined
        }
        size="xl"
        /* A long form, so the BODY grows with the window rather than stopping
           at the default 60vh — six cards read through a letterbox otherwise.
           See the note on `bodyGrows` in Modal. */
        bodyGrows
        /* Half-typed customer details are exactly the work a stray click must
           not throw away. */
        closeOnBackdrop={false}
        footer={
          <>
            <Button variant="ghost" size={size === 'touch' ? 'touch' : 'md'} onClick={onClose}>
              Cancel
            </Button>
            {/* Submits the form by id from outside it — the same mechanism the
                page header's Save uses. Rendered here rather than by the form
                because a dialog's actions belong in its footer. */}
            {ready && (
              <Button
                type="submit"
                form="customer-form"
                variant="primary"
                size={size === 'touch' ? 'touch-lg' : 'md'}
                className={size === 'touch' ? 'flex-1 justify-center' : undefined}
              >
                <Icons.Save size={size === 'touch' ? 20 : 15} />
                {isNew ? 'Create customer' : 'Save changes'}
              </Button>
            )}
          </>
        }
      >
        {loadError && (
          <Callout tone="danger" title="Could not open the form">
            {loadError}
          </Callout>
        )}

        {!loadError && !ready && (
          /* At the real shape of the form rather than a spinner, so the dialog
             does not collapse and then shove its own footer down the screen
             when the fields arrive. */
          <div className="flex flex-col gap-4">
            <Skeleton className="h-32 w-full rounded-card" />
            <Skeleton className="h-48 w-full rounded-card" />
            <Skeleton className="h-32 w-full rounded-card" />
          </div>
        )}

        {!loadError && ready && lookups && (
          <CustomerForm
            customer={customer}
            groups={lookups.groups}
            reps={lookups.reps}
            categories={lookups.categories}
            structures={lookups.structures}
            /* Only when creating. An existing account keeps the code it has,
               and offering it a fresh suggestion would invite a rename that
               every past document still refers to by the old one. */
            suggestedCode={isNew ? lookups.suggestedCode : null}
            size={size}
            overrideToken={overrideToken || undefined}
            onNeedsPermission={() => setAskingManager(true)}
            onSaved={(saved) => {
              toast.success(isNew ? `${saved.name} added` : `${saved.name} saved`)
              onSaved(saved)
              onClose()
            }}
          />
        )}
      </Modal>

      {/* Mounted only while one is pending, so the pad starts clean each time
          rather than carrying the last refusal's error into the next ask. */}
      {askingManager && (
        <OverrideModal
          open
          siteId={siteId}
          /* Always online here: the dialog cannot load its own lookups without
             the line, so the offline branch is unreachable. The callers refuse
             to open it offline in the first place. */
          online
          capability="customers.edit"
          actionLabel={isNew ? 'Add a new customer' : `Edit customer ${customer?.name ?? ''}`.trim()}
          cashierName={operatorName}
          onClose={() => setAskingManager(false)}
          onAuthorised={(auth) => {
            setOverrideToken(auth.token)
            setAskingManager(false)
            /* Says what to do next. The token authorises the save; it does not
               perform it, and a manager walking away at this point would leave
               the cashier looking at an unchanged form wondering if it took. */
            toast.info(`${auth.name} authorised this — press Save to finish.`)
          }}
        />
      )}
    </>
  )
}

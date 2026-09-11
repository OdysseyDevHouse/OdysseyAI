'use client'

import { useState } from 'react'
import { Button, Switch } from '@/components/ui'
import { CustomerModal } from '@/app/(pos)/pos/CustomerModal'
import type { TillCustomer } from '@/lib/site/tillCustomers'
import { NO_SPEND } from '@/lib/creditRules'

/**
 * The till's customer dialog, on the Style Guide.
 *
 * Here for the reason TenderPreview is: the POS sits behind a clerk PIN and a
 * device licence, so without this the only way to look at this dialog is to be
 * standing at a till with a basket open. What is worth looking at here is the
 * pair of affordances that let a cashier open or correct an account without
 * leaving the sale — and the state where they are deliberately refused.
 *
 * The customer is a fixture. Attaching, clearing and naming a walk-in only move
 * this component's own state; nothing touches a sale. The editor behind the two
 * buttons is real, though — it loads the live form and would save a real
 * account, which is the point of being able to reach it from here at all.
 */

const FIXTURE: TillCustomer = {
  id: 1,
  code: 'CUST00042',
  name: 'Marlene Abrahams',
  status: 'active',
  accountType: 'balance_fwd',
  creditLimit: 5000,
  dailyLimit: 0,
  monthlyLimit: 0,
  balance: 3760,
  availableCredit: 1240,
  overLimit: false,
  spend: NO_SPEND,
  remainingDaily: null,
  remainingMonthly: null,
  paymentTermsDays: 30,
  vatNumber: null,
  phone: '082 555 0142',
  creditBlockedReason: null,
  priceStructureId: null,
  discountPct: 0,
  groupId: null,
}

export function CustomerPreview() {
  const [open, setOpen] = useState(false)
  /* The two states worth comparing side by side, because they are what the
     cashier sees differently: with an account attached the card carries a
     pencil, without one the dialog is a search with a way to open an account
     at the end of it. */
  const [attached, setAttached] = useState<TillCustomer | null>(FIXTURE)
  const [walkInName, setWalkInName] = useState('')
  /* Offline is the state the two affordances are REFUSED in, and the one most
     worth being able to look at: a customer code comes from a server-side
     sequence, so an account genuinely cannot be opened with the line down. The
     buttons stay put and say why rather than disappearing. */
  const [online, setOnline] = useState(true)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Open the customer dialog
        </Button>
        <Switch
          checked={attached !== null}
          onChange={(next) => setAttached(next ? FIXTURE : null)}
          label="An account is attached"
          hint="Off shows the search on its own; on adds the account card and its pencil."
        />
        <Switch
          checked={online}
          onChange={setOnline}
          label="The till has a line"
          hint="Off disables both affordances and says why — an account cannot be numbered offline."
        />
      </div>

      <CustomerModal
        open={open}
        siteId={0}
        online={online}
        customer={attached}
        walkInName={walkInName}
        operatorName="Style Guide"
        onClose={() => setOpen(false)}
        onAttach={setAttached}
        onClear={() => setAttached(null)}
        onWalkInName={setWalkInName}
        /* The real dialog re-reads the saved account as a full TillCustomer.
           Here there is no sale to attach it to, so the preview just shows the
           fixture again — what is being looked at is the route in, not the
           attach. */
        onAttachById={() => setAttached(FIXTURE)}
      />
    </div>
  )
}

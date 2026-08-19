'use client'

import { useState } from 'react'
import { Button } from '@/components/ui'
import { TenderPad } from '@/app/(pos)/pos/TenderPad'
import type { TenderType } from '@/lib/site/tenderTypes'

/**
 * The till's take-payment screen, on the Style Guide.
 *
 * Here for the reason SplitPreview is: the POS sits behind a clerk PIN, so
 * without this the only way to look at the pad is to be standing at a till
 * with a basket open. The tenders are fixtures shaped like the seeded rows;
 * nothing here touches a sale, and `onFinalise` only closes the modal.
 */

const tender = (
  id: number,
  code: string,
  name: string,
  icon: string,
  extra: Partial<TenderType> = {},
): TenderType => ({
  id,
  code,
  name,
  postsToDebtor: false,
  requiresCustomer: false,
  countsAsDrawerCash: false,
  opensCashDrawer: false,
  allowsChange: false,
  allowsSplit: true,
  allowsRefund: true,
  tipOnOverTender: false,
  tipInDrawer: false,
  requiresReference: false,
  referenceLabel: null,
  roundsToCashDenomination: false,
  minAmount: 0,
  maxAmount: 0,
  surchargePct: 0,
  integrationKey: null,
  icon,
  color: null,
  position: id,
  isActive: true,
  isSystem: true,
  ...extra,
})

/* The six a ZA shop meets at the counter, in the order the seeds position
   them — so the preview shows the real key layout rather than a tidy one. */
const TENDERS: TenderType[] = [
  tender(1, 'CASH', 'Cash', 'Banknote', {
    countsAsDrawerCash: true,
    opensCashDrawer: true,
    allowsChange: true,
    roundsToCashDenomination: true,
  }),
  /* `tipOnOverTender` ON, because that is the case worth being able to look at:
     a card cannot give change, so R400 on a R344 bill is a R56 tip by definition
     and the pad fills the tip box itself. Without a tender configured this way
     the preview can only show the half of the tip behaviour a person declares. */
  tender(2, 'CARD', 'Card', 'CreditCard', { opensCashDrawer: true, tipOnOverTender: true }),
  /* Refused on this preview, because a walk-in has no customer — which is the
     state worth looking at: the key keeps its place and says why. */
  tender(3, 'ACCOUNT', 'Account', 'Users', {
    postsToDebtor: true,
    requiresCustomer: true,
  }),
  tender(4, 'EFT', 'Direct deposit', 'Building2', {
    requiresReference: true,
    referenceLabel: 'Deposit reference',
  }),
  tender(5, 'ONLINE', 'Online payment', '', {
    requiresReference: true,
    referenceLabel: 'Payment reference',
  }),
  tender(6, 'EXCHANGE', 'Exchange credit', ''),
]

export function TenderPreview() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Open the tender pad
      </Button>
      <TenderPad
        open={open}
        onClose={() => setOpen(false)}
        tenders={TENDERS}
        /* 344, so the preview matches the worked example in the pad's own
           notes: R400 on a card that keeps its over-payment is a R56 tip. */
        totalIncl={344}
        cashRounding={0.1}
        customer={null}
        pending={false}
        onFinalise={() => setOpen(false)}
      />
    </>
  )
}

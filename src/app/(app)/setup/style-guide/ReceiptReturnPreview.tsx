'use client'

import { useState } from 'react'
import { Button } from '@/components/ui'
import type { PickableReason } from '@/components/ui'
import type { TenderType } from '@/lib/site/tenderTypes'
import ReceiptReturnModal from '@/app/(pos)/pos/ReceiptReturnModal'
import type { ReceiptLookup, ReceiptSummary } from '@/app/(pos)/pos/returnActions'

/**
 * The till's receipt finder, on the Style Guide.
 *
 * Here for the reason every till screen on this page is: `/pos` sits behind a
 * clerk PIN whose hashes cannot be read back, so without this the only way to
 * look at the screen is to be standing at a till. Both reads are injected — see
 * the `listReceipts` / `findReceipt` props on the modal — so nothing here
 * touches a sale.
 *
 * The fixtures are chosen to show the cases the layout has to survive rather
 * than a tidy five: a walk-in with no name, a long customer name, a sale
 * already partly credited, and a figure wide enough to test the column.
 */

const RECEIPTS: ReceiptSummary[] = [
  {
    documentId: 9101,
    documentNumber: 'INV_01_01_000318',
    documentDate: '2026-08-23',
    finalisedAt: '14:52',
    customerName: null,
    totalIncl: 249.9,
    terminalCode: 'T01',
    userName: 'Rethabile',
    partlyCredited: false,
  },
  {
    documentId: 9102,
    documentNumber: 'INV_01_01_000317',
    documentDate: '2026-08-23',
    finalisedAt: '14:31',
    customerName: 'Van der Merwe Bouers (Edms) Bpk',
    totalIncl: 12480.55,
    terminalCode: 'T01',
    userName: 'Rethabile',
    partlyCredited: false,
  },
  {
    documentId: 9103,
    documentNumber: 'INV_01_01_000316',
    documentDate: '2026-08-23',
    finalisedAt: '13:08',
    customerName: 'Sipho Ndlovu',
    totalIncl: 89,
    terminalCode: 'T02',
    userName: 'Johan',
    partlyCredited: true,
  },
  {
    documentId: 9104,
    documentNumber: 'INV_01_01_000315',
    documentDate: '2026-08-23',
    finalisedAt: '11:47',
    customerName: null,
    totalIncl: 55,
    terminalCode: 'T02',
    userName: 'Johan',
    partlyCredited: false,
  },
]

/* One sale opened, with a line already part-credited — the case the steppers cap
   against, and the reason the list flags it before the cashier taps in. */
const OPENED: Extract<ReceiptLookup, { ok: true }>['invoice'] = {
  documentId: 9103,
  documentNumber: 'INV_01_01_000316',
  documentDate: '2026-08-23',
  customerId: 41,
  customerName: 'Sipho Ndlovu',
  totalIncl: 89,
  tenders: [{ tenderTypeId: 1, tenderName: 'Cash', amount: 89 }],
  lines: [
    {
      lineId: 1,
      description: 'County Fair Frozen Whole Chicken 1.8kg',
      productCode: 'CFW',
      qtySold: 1,
      alreadyCredited: 0,
      creditable: 1,
      unitPriceIncl: 89,
      vatRatePct: 15,
    },
    {
      lineId: 2,
      description: 'Country Fresh Chocolate 2L',
      productCode: 'CFC',
      qtySold: 2,
      alreadyCredited: 1,
      creditable: 1,
      unitPriceIncl: 55,
      vatRatePct: 15,
    },
    {
      lineId: 3,
      description: 'Cheese Grillers (6)',
      productCode: 'CG',
      qtySold: 1,
      alreadyCredited: 1,
      creditable: 0,
      unitPriceIncl: 55,
      vatRatePct: 15,
    },
  ],
}

const REASONS: PickableReason[] = [
  { id: 1, code: 'FAULTY', name: 'Faulty', allowsNote: true },
  { id: 2, code: 'WRONG', name: 'Wrong item', allowsNote: true },
  { id: 3, code: 'CHANGED', name: 'Changed their mind', allowsNote: false },
]

/* Only `id`, `code`, `name` and `allowsRefund` are read by this screen; the rest
   are the engine's business and are here to satisfy the type honestly rather
   than through a cast. */
const tender = (id: number, code: string, name: string, allowsRefund: boolean): TenderType => ({
  id,
  code,
  name,
  postsToDebtor: false,
  requiresCustomer: false,
  countsAsDrawerCash: code === 'CASH',
  opensCashDrawer: code === 'CASH',
  allowsChange: code === 'CASH',
  allowsSplit: true,
  allowsRefund,
  tipOnOverTender: false,
  tipInDrawer: false,
  requiresReference: false,
  referenceLabel: null,
  roundsToCashDenomination: code === 'CASH',
  minAmount: 0,
  maxAmount: 0,
  surchargePct: 0,
  integrationKey: null,
  icon: null,
  color: null,
  position: id,
  isActive: true,
  isSystem: true,
})

const TENDERS: TenderType[] = [
  tender(1, 'CASH', 'Cash', true),
  tender(2, 'CARD', 'Card', true),
  tender(3, 'VOUCHER', 'Voucher', false),
]

export function ReceiptReturnPreview() {
  const [open, setOpen] = useState(false)
  const [online, setOnline] = useState(true)

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Open the receipt finder
      </Button>
      {/* The offline face is a different screen, not a disabled one — a
          receipted return cannot run without the connection at all. */}
      <Button
        variant="ghost"
        onClick={() => {
          setOnline(false)
          setOpen(true)
        }}
      >
        Offline
      </Button>
      <ReceiptReturnModal
        open={open}
        online={online}
        reasons={REASONS}
        tenders={TENDERS}
        busy={false}
        onClose={() => {
          setOpen(false)
          setOnline(true)
        }}
        onRefund={() => setOpen(false)}
        onExchange={() => setOpen(false)}
        listReceipts={async ({ range, search }) => {
          /* Enough behaviour to exercise the screen: the search filters, and
             `yesterday` is deliberately empty so the empty state is reachable. */
          const term = search?.trim().toLowerCase() ?? ''
          if (!term && range === 'yesterday') return { ok: true, receipts: [], truncated: false }
          const rows = term
            ? RECEIPTS.filter(
                (r) =>
                  r.documentNumber.toLowerCase().includes(term) ||
                  (r.customerName ?? '').toLowerCase().includes(term),
              )
            : RECEIPTS
          return { ok: true, receipts: rows, truncated: false }
        }}
        findReceipt={async () => ({ ok: true, invoice: OPENED })}
      />
    </>
  )
}

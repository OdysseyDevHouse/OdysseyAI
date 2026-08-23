'use client'

import { useState } from 'react'
import { Button } from '@/components/ui'
import { BillModal } from '@/app/(pos)/pos/BillModal'
import type { BillData } from '@/lib/billData'

/**
 * The till's bill dialog, on the Style Guide.
 *
 * Here for the reason everything on this page is: it is a composed screen the kit has to
 * keep working, and the POS itself is behind a clerk PIN — so without this the only way
 * to look at it is to be standing at a till with a table open. The data is fixtures;
 * nothing here reads or prints a real bill.
 */

/* A table of four mid-service: two lines carrying instruction answers, because those are
   what make a bill taller than its item count and are the thing most likely to break the
   slip's layout. */
const BILL: BillData = {
  proForma: true,
  siteName: 'Odyssey Cafe Sea Point',
  vatNumber: '4123456789',
  label: 'T04',
  covers: 4,
  userName: 'Tiaan',
  printedAt: '19/08/26, 09:30',
  lines: [
    {
      description: 'Calamari Strips',
      qty: 1,
      unitPriceIncl: 125,
      lineTotalIncl: 125,
      notes: ['Extra lemon'],
    },
    { description: 'New York Street Dog', qty: 2, unitPriceIncl: 72, lineTotalIncl: 144, notes: [] },
    {
      description: 'Chicken & Chips Basket',
      qty: 1,
      unitPriceIncl: 105,
      lineTotalIncl: 105,
      notes: ['No mayo', 'Chips well done'],
    },
    { description: 'Still Water 500ml', qty: 4, unitPriceIncl: 22, lineTotalIncl: 88, notes: [] },
  ],
  subtotalExcl: 400,
  vatTotal: 62,
  discountTotal: 0,
  totalIncl: 462,
  vatByRate: [{ ratePct: 15, excl: 400, vat: 62, incl: 462 }],
}

export function BillPreview() {
  const [open, setOpen] = useState(false)
  /* The loading state is worth looking at rather than only the settled one — it is what
     a waiter sees for the length of a round trip on every single press. */
  const [loading, setLoading] = useState(false)

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          onClick={() => {
            setLoading(false)
            setOpen(true)
          }}
        >
          Open the bill
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setLoading(true)
            setOpen(true)
          }}
        >
          …while it is loading
        </Button>
      </div>
      <BillModal
        open={open}
        bill={loading ? null : BILL}
        loading={loading}
        printing={false}
        onClose={() => setOpen(false)}
        onPrint={() => setOpen(false)}
      />
    </>
  )
}

'use client'

import { useState } from 'react'
import { Button } from '@/components/ui'
import {
  SplitBillModal,
  type SplitLine,
  type SplitDestination,
} from '@/app/(pos)/pos/SplitBillModal'

/**
 * The till's split screen, on the Style Guide.
 *
 * It is here for the reason everything on this page is: it is a composed screen the kit
 * has to keep working, and the POS itself is behind a clerk PIN — so without this the
 * only way to look at it is to be standing at a till. The data is fixtures; nothing here
 * touches a bill.
 */

/* Destinations are OPEN SALES, not floor tables — which is why the fixtures mix seated
   bills with free-text tabs. A shop's floor is mostly the latter. */
const DESTINATIONS: SplitDestination[] = [
  { documentId: 9002, label: '111111', tableCode: '111111', lineCount: 4, totalIncl: 250 },
  { documentId: 9003, label: '112', tableCode: '112', lineCount: 3, totalIncl: 199 },
  { documentId: 9004, label: 'Walk-in', tableCode: null, lineCount: 3, totalIncl: 110 },
  { documentId: 9005, label: 'Tiaan', tableCode: null, lineCount: 3, totalIncl: 122 },
  { documentId: 9007, label: '555', tableCode: '555', lineCount: 9, totalIncl: 215.24 },
]

/* Two of these carry MODIFIERS, and one pair is deliberately the same product ordered
   two ways — which is the case the answers exist to disambiguate on this screen. */
const LINES: SplitLine[] = [
  {
    id: 1,
    description: 'Calamari Strips',
    productCode: 'CAL',
    qty: 1,
    unitPriceIncl: 125,
    lineTotalIncl: 125,
    note: 'Compound Butter',
    instructions: [{ optionName: 'Extra lemon', qty: 1 }],
  },
  { id: 2, description: 'Boerewors Chakalaka per kg', productCode: 'BWC', qty: 1, unitPriceIncl: 119, lineTotalIncl: 119 },
  {
    id: 3,
    description: 'Beef Burger',
    productCode: 'BB',
    qty: 2,
    unitPriceIncl: 105,
    lineTotalIncl: 210,
    instructions: [
      { optionName: 'Medium rare', qty: 1 },
      { optionName: 'No onions', qty: 2 },
    ],
  },
  {
    id: 4,
    description: 'Beef Burger',
    productCode: 'BB',
    qty: 1,
    unitPriceIncl: 105,
    lineTotalIncl: 105,
    instructions: [{ optionName: 'Well done', qty: 1 }],
  },
  { id: 5, description: 'Cheese Grillers (6)', productCode: 'CG', qty: 1, unitPriceIncl: 55, lineTotalIncl: 55 },
]

const EXISTING: SplitLine[] = [
  {
    id: 91,
    description: 'Country Fresh Chocolate 2L',
    productCode: 'CFC',
    qty: 1,
    unitPriceIncl: 55,
    lineTotalIncl: 55,
    instructions: [{ optionName: 'No straw', qty: 1 }],
  },
  { id: 92, description: 'Country Fresh Neapolitan 2L', productCode: 'CFN', qty: 1, unitPriceIncl: 55, lineTotalIncl: 55 },
  { id: 93, description: 'County Fair Frozen Whole Chicken 1.8kg', productCode: 'CFW', qty: 1, unitPriceIncl: 89, lineTotalIncl: 89 },
]

export function SplitPreview() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Open split screen
      </Button>
      <SplitBillModal
        open={open}
        onClose={() => setOpen(false)}
        fromLabel="T01"
        lines={LINES}
        destinations={DESTINATIONS}
        busy={false}
        loadDestinationLines={async () => EXISTING}
        onConfirm={() => setOpen(false)}
      />
    </>
  )
}

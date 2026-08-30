'use client'

import { useState } from 'react'
import { Button } from '@/components/ui'
import { VariantModal } from '@/app/(pos)/pos/VariantModal'
import type { TillProduct } from '@/lib/site/tillSearch'

/**
 * The till's size/colour picker, on the Style Guide.
 *
 * Here for the reason every till screen on this page is: `/pos` sits behind a
 * clerk PIN whose hashes cannot be read back, so without this the only way to
 * look at the screen is to be standing at a till. This one needs no injected
 * reads at all — the modal takes its members and axis labels as props, because
 * the shell fetches them before opening it.
 *
 * Two fixtures, because the one-axis and two-axis cases are different screens
 * rather than the same screen with a row hidden:
 *
 *   · ONE AXIS is the common shop: four sizes, one of them sold out.
 *   · TWO AXES is where the layout earns its keep — an INCOMPLETE grid, with no
 *     XL in red, so the disabled state is on screen rather than described.
 */

/* Only what the picker reads is meaningful; the rest satisfies the type
   honestly rather than through a cast. */
function member(
  id: number,
  code: string,
  description: string,
  axis1: string,
  axis2: string,
  stock: number,
  priceIncl: number,
): TillProduct {
  return {
    id,
    code,
    barcode: null,
    barcodes: [],
    description,
    productType: 'normal',
    departmentId: 1,
    priceIncl,
    vatRatePct: 15,
    costExcl: priceIncl / 2,
    stockOnHand: stock,
    reservedQty: 0,
    availableQty: stock,
    askPriceAtSale: false,
    allowFractions: false,
    scaleItem: false,
    variableType: 'none',
    maxDiscountPct: 0,
    imageColor: null,
    imageIcon: null,
    posSortOrder: 0,
    hasVariants: false,
    parentId: 900,
    axis1Value: axis1,
    axis2Value: axis2,
    variantSort: 0,
  }
}

/** The group tile itself — never sold, only tapped. */
const PARENT: TillProduct = {
  ...member(900, 'TEE', 'Cotton T-Shirt', '', '', 0, 0),
  hasVariants: true,
  parentId: null,
}

/* Sizes in SHELF order, not alphabetical — S, M, L, XL sorts to L, M, S, XL,
   which is the nonsense `variant_sort` exists to prevent (070). */
const ONE_AXIS: TillProduct[] = [
  member(901, 'TEE-S', 'Cotton T-Shirt S', 'S', '', 6, 199),
  member(902, 'TEE-M', 'Cotton T-Shirt M', 'M', '', 0, 199),
  member(903, 'TEE-L', 'Cotton T-Shirt L', 'L', '', 3, 199),
  member(904, 'TEE-XL', 'Cotton T-Shirt XL', 'XL', '', 2, 219),
]

/* Deliberately incomplete: the shop stocks XL in black but not in red. */
const TWO_AXES: TillProduct[] = [
  member(911, 'TEE-S-BLK', 'Cotton T-Shirt S Black', 'S', 'Black', 5, 199),
  member(912, 'TEE-S-RED', 'Cotton T-Shirt S Red', 'S', 'Red', 3, 199),
  member(913, 'TEE-M-BLK', 'Cotton T-Shirt M Black', 'M', 'Black', 0, 199),
  member(914, 'TEE-M-RED', 'Cotton T-Shirt M Red', 'M', 'Red', 7, 199),
  member(915, 'TEE-XL-BLK', 'Cotton T-Shirt XL Black', 'XL', 'Black', 2, 219),
]

export function VariantPreview() {
  const [open, setOpen] = useState<null | 'one' | 'two'>(null)

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen('one')}>
        One axis
      </Button>
      <Button variant="secondary" onClick={() => setOpen('two')}>
        Two axes
      </Button>
      {open && (
        <VariantModal
          parent={PARENT}
          childrenProducts={open === 'one' ? ONE_AXIS : TWO_AXES}
          axes={
            open === 'one'
              ? [{ position: 1, label: 'Size' }]
              : [
                  { position: 1, label: 'Size' },
                  { position: 2, label: 'Colour' },
                ]
          }
          priceFor={(p) => p.priceIncl}
          onCancel={() => setOpen(null)}
          onConfirm={() => setOpen(null)}
        />
      )}
    </>
  )
}

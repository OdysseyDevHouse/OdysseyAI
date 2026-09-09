/**
 * From parsed value to money on the slip, with no database.
 *
 * Builds the TillProduct resolveScan would hand back for the tester's product
 * — code 5432, shelf price 23.95, description "Variable price Item" — under
 * each variable_type, and asks the real basket builder what the line costs.
 * The point is the CONTRAST: the same barcode is money under one setting and
 * a weight under the other two, and only one of the three charges R15.99.
 */
import { lineFromProduct } from '../src/lib/basket'
import { roundQty } from '../src/lib/decimals'
import type { TillProduct } from '../src/lib/site/tillSearch'
import type { VariableTypeId } from '../src/lib/productProperties'

const VALUE = 15.99
const SHELF = 23.95

function product(variableType: VariableTypeId): TillProduct {
  return {
    id: 1, code: '5432', barcode: '6054321015996', barcodes: [],
    description: 'Variable price Item', productType: 'stock', departmentId: null,
    priceIncl: SHELF, vatRatePct: 15, costExcl: 0,
    stockOnHand: 0, reservedQty: 0, availableQty: 0,
    askPriceAtSale: false, changeDescription: false, chargePctSubtotal: false,
    allowFractions: false, qtyDecimals: 0, scaleItem: false,
    variableType, maxDiscountPct: 0, imageColor: null, imageIcon: null,
    posSortOrder: 0, hasVariants: false, parentId: null,
    axis1Value: '', axis2Value: '',
  } as unknown as TillProduct
}

console.log(`\nembedded value ${VALUE}, shelf price ${SHELF}\n`)
for (const vt of ['price', 'weight', 'none'] as VariableTypeId[]) {
  const base = product(vt)
  // Exactly what tillSearch.ts:810 does with the parsed value.
  const scanned: TillProduct =
    vt === 'price'
      ? { ...base, scannedPrice: VALUE }
      : { ...base, scannedQty: roundQty(VALUE, base) }
  const line = lineFromProduct(scanned, scanned.scannedQty ?? 1, 0)
  const total = line.qty * line.unitPriceIncl
  console.log(
    `  variable_type '${vt}'`.padEnd(28) +
      `qty ${String(line.qty).padEnd(5)} x R${line.unitPriceIncl.toFixed(2).padStart(7)}  =  R${total.toFixed(2)}` +
      (total === VALUE && line.qty === 1 ? '   <-- what the tester expects' : ''),
  )
}
console.log()

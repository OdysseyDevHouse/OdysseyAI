/**
 * Runs the APP's own reconcilers against whatever is in site 1.
 *
 * seed-stress.mjs checks its work with its own SQL, which proves only that it
 * agrees with itself. This asks the code the product actually ships.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/check-seed.ts
 */
import { reconcileStock } from '../src/lib/site/stockMovements'
import { reconcileBalances } from '../src/lib/site/customerLedger'
import { reconcileSupplierBalances } from '../src/lib/site/supplierLedger'
import { verifySequence } from '../src/lib/site/sequences'

const SITE = 1
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  const stock = await reconcileStock(SITE)
  const stockDrift = Array.isArray(stock) ? stock.length : (stock as any)?.drift?.length ?? 0
  ok('stock reconciles', stockDrift === 0, `${stockDrift} drifting`)

  const cust = await reconcileBalances(SITE)
  const custDrift = Array.isArray(cust) ? cust.length : (cust as any)?.length ?? 0
  ok('customer balances reconcile', custDrift === 0, `${custDrift} drifting`)

  const supp = await reconcileSupplierBalances(SITE)
  const suppDrift = Array.isArray(supp) ? supp.length : (supp as any)?.length ?? 0
  ok('supplier balances reconcile', suppDrift === 0, `${suppDrift} drifting`)

  // A seeded number must never collide with the next real one.
  for (const t of ['invoice', 'credit_sale', 'grv', 'purchase_order']) {
    const seq: any = await verifySequence(SITE, t as any)
    const good = seq?.ok !== false && !seq?.duplicates?.length
    ok(`sequence ${t} intact`, good, JSON.stringify(seq).slice(0, 160))
  }

  console.log(fails ? `\n${fails} check(s) failed.` : '\nAll checks passed.')
  process.exit(fails ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })

/**
 * Period locks, enforced end to end.
 *
 * test-accounting.ts proves the lock TABLE behaves. This proves the GUARDS are
 * actually wired into the paths that move money — which is a different claim,
 * and the one that matters: a lock nothing checks is decoration.
 *
 *   npm run test:period-locks
 */
import { siteExecute } from '../src/lib/siteDb'
import { createCustomer } from '../src/lib/site/customers'
import { createSupplier } from '../src/lib/site/suppliers'
import { postTransaction, reverseTransaction } from '../src/lib/site/customerLedger'
import { postSupplierTransaction } from '../src/lib/site/supplierLedger'
import { lockPeriod, unlockPeriod } from '../src/lib/site/periodLocks'
import { isPeriodLocked } from '../src/lib/site/settings'
import { requestWriteOff } from '../src/lib/site/writeOffs'

const SITE = 1
const actor = { userId: 1, userName: 'Lock Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const stamp = Date.now().toString().slice(-6)

async function main() {
  // A window well in the past, so it cannot collide with anything real.
  const from = daysAgo(500)
  const to = daysAgo(480)
  const inside = daysAgo(490)
  const outside = daysAgo(470)

  const cust = await createCustomer(SITE, actor, {
    code: `LK${stamp}`, name: 'Lock Test Co', paymentTermsDays: 30, creditLimit: 50000,
  })
  const sup = await createSupplier(SITE, actor, {
    code: `LKS${stamp}`, name: 'Lock Test Supplier', paymentTermsDays: 30,
  })
  if (!cust.ok || !sup.ok) {
    console.log('**FAIL**  could not create test parties')
    process.exit(1)
  }

  // Post something inside the window BEFORE locking, to reverse later.
  const preLock = await postTransaction(SITE, actor, {
    customerId: cust.id, docType: 'invoice', amount: 1000,
    docDate: inside, docNumber: `LKINV${stamp}`,
  })
  ok('an invoice posts freely while the period is open', preLock.ok)

  const lock = await lockPeriod(SITE, actor, {
    periodFrom: from, periodTo: to, lockType: 'hard', scope: 'all', reason: 'Return filed',
  })
  ok('period locked', lock.ok, lock.ok ? '' : lock.error)
  if (!lock.ok) return finish(cust.id, sup.id, 0)

  console.log('\n── The guards ──────────────────────────────────────────────\n')

  const blockedCustomer = await postTransaction(SITE, actor, {
    customerId: cust.id, docType: 'invoice', amount: 500,
    docDate: inside, docNumber: `BLOCK${stamp}`,
  })
  ok('*** customer ledger refuses a posting inside the lock ***', !blockedCustomer.ok,
      blockedCustomer.ok ? 'IT POSTED' : blockedCustomer.error)

  const blockedSupplier = await postSupplierTransaction(SITE, actor, {
    supplierId: sup.id, docType: 'invoice', amount: 500,
    docDate: inside, docNumber: `BLOCKS${stamp}`,
  })
  ok('*** supplier ledger refuses a posting inside the lock ***', !blockedSupplier.ok,
      blockedSupplier.ok ? 'IT POSTED' : blockedSupplier.error)

  const blockedWriteOff = await requestWriteOff(SITE, actor, {
    customerId: cust.id, amount: 100, reason: 'Testing the lock guard',
    writeOffDate: inside,
  })
  ok('*** write-off refuses a date inside the lock ***', !blockedWriteOff.ok,
      blockedWriteOff.ok ? 'IT POSTED' : blockedWriteOff.error)

  // Reversing a document that SITS inside a closed period changes that
  // period's figures even though the reversal is dated today.
  if (preLock.ok) {
    const blockedReversal = await reverseTransaction(SITE, actor, preLock.id, 'Testing')
    ok('*** reversing a document inside a closed period is refused ***', !blockedReversal.ok,
        blockedReversal.ok ? 'IT REVERSED' : blockedReversal.error)
  }

  // The legacy setting-based check must see the new table too, because sales
  // and purchasing call it rather than guardPosting.
  ok('*** isPeriodLocked (sales/purchasing path) sees the new table ***',
      await isPeriodLocked(SITE, inside))
  ok('  and leaves open dates alone', !(await isPeriodLocked(SITE, outside)))

  const allowed = await postTransaction(SITE, actor, {
    customerId: cust.id, docType: 'invoice', amount: 500,
    docDate: outside, docNumber: `OPEN${stamp}`,
  })
  ok('a posting outside the lock still works', allowed.ok, allowed.ok ? '' : allowed.error)

  console.log('\n── Reopening ───────────────────────────────────────────────\n')

  ok('reopened', (await unlockPeriod(SITE, actor, lock.id, 'Correction needed')).ok)

  const afterUnlock = await postTransaction(SITE, actor, {
    customerId: cust.id, docType: 'invoice', amount: 500,
    docDate: inside, docNumber: `AFTER${stamp}`,
  })
  ok('*** posting works again once reopened ***', afterUnlock.ok,
      afterUnlock.ok ? '' : afterUnlock.error)

  await finish(cust.id, sup.id, lock.id)
}

async function finish(customerId: number, supplierId: number, lockId: number) {
  await siteExecute(SITE, 'DELETE FROM period_locks WHERE id = ?', [lockId])
  await siteExecute(SITE, 'DELETE FROM debt_write_offs WHERE customer_id = ?', [customerId])
  await siteExecute(SITE, 'DELETE FROM customer_allocations WHERE debit_txn_id IN (SELECT id FROM customer_transactions WHERE customer_id = ?) OR credit_txn_id IN (SELECT id FROM customer_transactions WHERE customer_id = ?)', [customerId, customerId])
  await siteExecute(SITE, 'DELETE FROM customer_transactions WHERE customer_id = ?', [customerId])
  await siteExecute(SITE, 'DELETE FROM customers WHERE id = ?', [customerId])
  await siteExecute(SITE, 'DELETE FROM supplier_transactions WHERE supplier_id = ?', [supplierId])
  await siteExecute(SITE, 'DELETE FROM suppliers WHERE id = ?', [supplierId])

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main()

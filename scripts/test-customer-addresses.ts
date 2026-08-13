/**
 * The customer address book — kinds, defaults, cascade.
 *
 * The rules that matter:
 *
 *   ONE DEFAULT PER KIND, swapped inside the save transaction (MariaDB has no
 *   partial unique index — the service_addresses rule).
 *
 *   NO ROWS IS AN ORDINARY ANSWER. defaultAddressFor returns null and the
 *   caller falls back to the customer's own billing columns.
 *
 *   DELETION ORPHANS NOTHING. Documents snapshot text, so rows go with a hard
 *   delete and the customer cascade.
 *
 *   npm run test:customer-addresses
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { createCustomer } from '../src/lib/site/customers'
import {
  listCustomerAddresses, saveCustomerAddress, deleteCustomerAddress,
  defaultAddressFor, formatAddress,
} from '../src/lib/site/customerAddresses'

const SITE = 1
const actor = { userId: 1, userName: 'Address Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const stamp = Date.now().toString().slice(-8)

async function main() {
  const cust = await createCustomer(SITE, actor, {
    code: `ADR${stamp}`, name: 'Address Test Co', paymentTermsDays: 30, creditLimit: 0,
  })
  if (!cust.ok) { console.log('**FAIL** setup'); process.exit(1) }

  ok('an empty book answers null', (await defaultAddressFor(SITE, cust.id, 'delivery')) === null)

  // ── Saving and the default swap
  const first = await saveCustomerAddress(SITE, actor, cust.id, {
    kind: 'delivery', label: 'Warehouse', line1: '12 Industry Rd', city: 'Parow',
    postalCode: '7500', isDefault: true,
  })
  ok('*** an address saves ***', first.ok)
  const second = await saveCustomerAddress(SITE, actor, cust.id, {
    kind: 'delivery', label: 'Shop', line1: '4 Main Rd', city: 'Bellville', isDefault: true,
  })
  ok('a second default saves', second.ok)

  const deliveries = await listCustomerAddresses(SITE, cust.id, { kind: 'delivery' })
  ok('*** exactly one default per kind ***',
    deliveries.filter((a) => a.isDefault).length === 1,
    JSON.stringify(deliveries.map((a) => `${a.label}:${a.isDefault}`)))
  ok('  and it is the newest choice', deliveries.find((a) => a.isDefault)?.label === 'Shop')

  const billing = await saveCustomerAddress(SITE, actor, cust.id, {
    kind: 'billing', label: 'Head office', line1: '1 Corporate Dr', isDefault: true,
  })
  ok('a billing default does not disturb delivery', billing.ok &&
    (await defaultAddressFor(SITE, cust.id, 'delivery'))?.label === 'Shop')
  ok('  kinds filter apart',
    (await listCustomerAddresses(SITE, cust.id, { kind: 'billing' })).length === 1)

  ok('a nameless address is refused',
    !(await saveCustomerAddress(SITE, actor, cust.id, { kind: 'delivery', label: '  ' })).ok)

  // ── Formatting
  ok('formatAddress joins what exists',
    formatAddress({ line1: '4 Main Rd', city: 'Bellville', postalCode: '7530' }) === '4 Main Rd, Bellville, 7530')
  ok('  and skips what does not', formatAddress({}) === '')

  // ── Deleting
  if (first.ok) {
    ok('*** deleting works ***', (await deleteCustomerAddress(SITE, actor, cust.id, first.id)).ok)
    ok('  and the row is gone',
      (await listCustomerAddresses(SITE, cust.id, { kind: 'delivery' })).length === 1)
  }
  ok("another customer's address cannot be deleted through this one",
    !(await deleteCustomerAddress(SITE, actor, cust.id + 999999, second.ok ? second.id : 0)).ok)

  // ── The cascade
  await siteExecute(SITE, 'DELETE FROM customers WHERE id = ?', [cust.id])
  const orphans = await siteQueryOne<any>(SITE,
    'SELECT COUNT(*) AS n FROM customer_addresses WHERE customer_id = ?', [cust.id])
  ok('*** the customer cascade sweeps the book ***', Number(orphans?.n) === 0,
    String(orphans?.n))

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await siteExecute(SITE, "DELETE FROM customers WHERE code LIKE 'ADR%'").catch(() => {})
  console.log('\nCRASHED — swept')
  process.exit(1)
})

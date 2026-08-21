/**
 * Do the screens I changed actually build their data without throwing?
 *
 * Not a substitute for opening them — it does not render JSX. What it does
 * cover is the half that breaks at REQUEST time rather than compile time: the
 * queries a page runs before it renders anything, which is where a renamed
 * column or a wrong-database call lands. tsc cannot see any of that, and the
 * dev server on 4100 is serving a build from before this work.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/probe-loyalty-screens.ts
 */
import { listMembers, listTiers, getLiability, getMember, enrolMember,
         getLoyaltySettings, saveLoyaltySettings, listLedger,
         memberIdForCustomer } from '../src/lib/site/loyalty'
import { getCardProgress, listVouchers, listCards } from '../src/lib/site/loyaltyCards'
import { listWallet, getWalletBalance } from '../src/lib/site/loyaltyWallet'
import { listCustomers, getCustomer } from '../src/lib/site/customers'
import { searchCustomersForTill } from '../src/lib/site/tillCustomers'
import { siteExecute } from '../src/lib/siteDb'

const SITE = 1
const ACTOR = { userId: 1, userName: 'Screen probe' }
const stamp = String(Date.now()).slice(-8)

let fails = 0
const ok = (l: string, c: boolean, d = '') => {
  if (!c) fails++
  console.log(`${c ? 'PASS' : '**FAIL**'}  ${l}${d ? '  -- ' + d : ''}`)
}
async function survives(label: string, fn: () => Promise<unknown>) {
  try {
    const v = await fn()
    ok(label, true)
    return v
  } catch (e) {
    ok(label, false, (e as Error).message)
    return null
  }
}

async function main() {
  const s = await getLoyaltySettings(SITE)
  await saveLoyaltySettings(SITE, ACTOR, { ...s, enabled: true })

  const cust = await siteExecute(
    SITE,
    `INSERT INTO customers (code, name, status, account_type) VALUES (?,?,'active','cash')`,
    [`SP${stamp}`, `Screen Customer ${stamp}`],
  )
  const customerId = cust.insertId
  const joined = await enrolMember(SITE, ACTOR, { name: `Screen Member ${stamp}`, customerId })
  if (!joined.ok) throw new Error(joined.error)
  const walkIn = await enrolMember(SITE, ACTOR, { name: `Screen WalkIn ${stamp}` })
  if (!walkIn.ok) throw new Error(walkIn.error)
  const memberId = joined.memberId

  console.log('\n── /loyalty (the members list) ────────────────────────────\n')
  const members = await survives('listMembers', () => listMembers(SITE)) as { rows: { memberId: number; customerId: number | null }[] } | null
  await survives('listTiers', () => listTiers(SITE))
  await survives('getLiability', () => getLiability(SITE))
  ok('*** rows carry memberId, which the table keys on ***',
     !!members?.rows.every((r) => Number.isFinite(r.memberId)))
  ok('*** and a walk-in row has a NULL customerId, not a broken link ***',
     members?.rows.some((r) => r.customerId === null) ?? false,
     'the name cell renders plain text rather than a link for these')

  console.log('\n── /customers/[id] — the Loyalty tab ──────────────────────\n')
  const resolved = await survives('memberIdForCustomer', () => memberIdForCustomer(SITE, customerId))
  ok('  it resolves to the member just enrolled', resolved === memberId, `${resolved}`)
  await survives('getMember', () => getMember(SITE, memberId))
  await survives('listLedger', () => listLedger(SITE, memberId))
  await survives('listVouchers', () => listVouchers(SITE, { memberId }))
  await survives('getCardProgress', () => getCardProgress(SITE, memberId))
  await survives('listWallet', () => listWallet(SITE, memberId))
  await survives('getWalletBalance', () => getWalletBalance(SITE, memberId))

  const noMember = await survives('a customer who never joined resolves to null',
                                  () => memberIdForCustomer(SITE, 999999))
  ok('*** and that is null, so the tab offers enrolment ***', noMember === null)

  console.log('\n── /customers and the till ────────────────────────────────\n')
  await survives('listCustomers (no loyalty_number column)', () => listCustomers(SITE, { limit: 5 }))
  await survives('listCustomers with a search term', () => listCustomers(SITE, { search: 'Screen', limit: 5 }))
  await survives('getCustomer', () => getCustomer(SITE, customerId))
  await survives('searchCustomersForTill', () => searchCustomersForTill(SITE, 'Screen'))
  await survives('/loyalty/cards', () => listCards(SITE, true))

  await siteExecute(SITE, 'DELETE FROM loyalty_members WHERE id IN (?,?)', [memberId, walkIn.memberId])
  await siteExecute(SITE, 'DELETE FROM customers WHERE id = ?', [customerId])

  console.log(fails === 0 ? '\nEvery screen builds its data.\n' : `\n${fails} FAILED\n`)
  process.exit(fails === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
